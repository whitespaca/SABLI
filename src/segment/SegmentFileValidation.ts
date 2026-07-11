import { open, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeJsonPath } from "../core/path.js";
import { encodeScopedPathKey } from "../indexes/scoped-index.js";
import { SabliCorruptionError, SabliStorageError } from "../errors/index.js";
import { stableJson } from "../storage/Checksum.js";
import type { OffsetTableFile } from "../storage/OffsetTable.js";
import type { SegmentId } from "../types/json.js";
import { assertIs } from "../validation/assertValid.js";
import { parseSegmentMetadata } from "../validation/SegmentMetadataValidation.js";
import {
  DeleteBitmapFileGuard,
  OffsetTableFileGuard,
  PathDictionaryFileGuard,
  PostingIndexFileGuard,
  ScopedPostingIndexFileGuard,
  SerializedBloomFilterGuard,
  ValueDictionaryFileGuard,
  type DeleteBitmapFileInput,
  type PostingIndexFileInput,
  type ScopedPostingIndexFileInput,
  type ScopedPostingPairInput
} from "../validation/schemas.js";
import type { SegmentMetadata } from "./SegmentMetadata.js";
import { encodeScopedTermIdentity } from "./ScopedPostingIndex.js";

const COMMON_SEGMENT_ARTIFACTS = [
  "segment.meta.json",
  "docs.bin",
  "docs.offset",
  "path.dict",
  "value.dict",
  "postings.idx",
  "bloom.bin",
  "delete.bitmap"
] as const;

const SCOPED_POSTING_ARTIFACT = "scoped-postings.idx" as const;

type SegmentArtifactName = (typeof COMMON_SEGMENT_ARTIFACTS)[number] | typeof SCOPED_POSTING_ARTIFACT;

/**
 * Optional manifest expectations used while validating an immutable segment.
 */
export interface SegmentFileValidationOptions {
  /** Segment identifier recorded by the active database manifest. */
  readonly expectedSegmentId?: SegmentId;
  /** Physical document count recorded by the active database manifest. */
  readonly expectedDocumentCount?: number;
}

/**
 * Persisted immutable-segment state validated before the segment becomes queryable.
 */
export interface ValidatedSegmentFileSet {
  /** Validated segment metadata and checksum. */
  readonly metadata: SegmentMetadata;
  /** Validated exact document offset table. */
  readonly offsetTable: OffsetTableFile;
  /** Validated posting index. */
  readonly postingIndex: PostingIndexFileInput;
  /** Validated scoped posting index, absent only for legacy version-1 segments. */
  readonly scopedPostingIndex?: ScopedPostingIndexFileInput;
  /** Validated visibility-critical delete bitmap. */
  readonly deleteBitmap: DeleteBitmapFileInput;
  /** Total bytes across the validated required segment artifacts. */
  readonly totalByteSize: number;
}

/**
 * Validates every required current-format immutable-segment artifact.
 *
 * @param root - Immutable segment directory.
 * @param options - Optional manifest values to cross-check.
 * @returns Parsed persisted state needed by the segment reader.
 * @throws {SabliCorruptionError} If a required artifact is missing, malformed, or inconsistent.
 * @throws {SabliStorageError} If a required artifact cannot be read for another filesystem reason.
 */
export async function validateSegmentFileSet(
  root: string,
  options: SegmentFileValidationOptions = {}
): Promise<ValidatedSegmentFileSet> {
  const segment = basename(root) || root;
  if (segment.endsWith(".tmp")) {
    throw new SabliCorruptionError(
      `Invalid immutable segment ${segment} artifact directory: temporary segment directories cannot become live.`
    );
  }

  let totalByteSize = await requireRegularFile(root, segment, "segment.meta.json");
  const metadataInput = await readJsonArtifact(root, segment, "segment.meta.json");
  const metadata = validateArtifact(segment, "segment.meta.json", () => parseSegmentMetadata(metadataInput));
  validateManifestExpectations(segment, metadata, options);

  let documentBlockSize = 0;
  const requiredArtifacts: readonly SegmentArtifactName[] = metadata.version >= 2
    ? [...COMMON_SEGMENT_ARTIFACTS, SCOPED_POSTING_ARTIFACT]
    : COMMON_SEGMENT_ARTIFACTS;
  for (const artifact of requiredArtifacts) {
    if (artifact === "segment.meta.json") {
      continue;
    }
    const size = await requireRegularFile(root, segment, artifact);
    totalByteSize += size;
    if (artifact === "docs.bin") {
      documentBlockSize = size;
    }
  }
  await assertDocumentBlockReadable(root, segment);

  if (metadata.version === 1 && await artifactExists(root, SCOPED_POSTING_ARTIFACT)) {
    throw segmentCorruption(
      segment,
      SCOPED_POSTING_ARTIFACT,
      "legacy segment metadata must not contain a current-format scoped posting artifact"
    );
  }

  const offsetInput = await readJsonArtifact(root, segment, "docs.offset");
  const offsetTable = validateArtifact(segment, "docs.offset", () =>
    assertIs(
      OffsetTableFileGuard,
      offsetInput,
      "corruption",
      "Invalid immutable segment document offset table."
    )
  );
  const physicalDocIds = validateOffsetTable(segment, metadata, offsetTable, documentBlockSize);

  const pathDictionaryInput = await readJsonArtifact(root, segment, "path.dict");
  const pathDictionary = validateArtifact(segment, "path.dict", () =>
    assertIs(
      PathDictionaryFileGuard,
      pathDictionaryInput,
      "corruption",
      "Invalid immutable segment path dictionary."
    )
  );
  validateUniqueStrings(segment, "path.dict", pathDictionary.paths);

  const valueDictionaryInput = await readJsonArtifact(root, segment, "value.dict");
  const valueDictionary = validateArtifact(segment, "value.dict", () =>
    assertIs(
      ValueDictionaryFileGuard,
      valueDictionaryInput,
      "corruption",
      "Invalid immutable segment value dictionary."
    )
  );
  validateUniqueStrings(segment, "value.dict", valueDictionary.values);

  const postingInput = await readJsonArtifact(root, segment, "postings.idx");
  const postingIndex = validateArtifact(segment, "postings.idx", () =>
    assertIs(
      PostingIndexFileGuard,
      postingInput,
      "corruption",
      "Invalid immutable segment posting index."
    )
  );
  validatePostingIndex(segment, postingIndex, physicalDocIds);

  let scopedPostingIndex: ScopedPostingIndexFileInput | undefined;
  if (metadata.version >= 2) {
    const scopedPostingInput = await readJsonArtifact(root, segment, SCOPED_POSTING_ARTIFACT);
    scopedPostingIndex = validateArtifact(segment, SCOPED_POSTING_ARTIFACT, () =>
      assertIs(
        ScopedPostingIndexFileGuard,
        scopedPostingInput,
        "corruption",
        "Invalid immutable segment scoped posting index."
      )
    );
    validateScopedPostingIndex(segment, scopedPostingIndex, physicalDocIds);
  }

  const bloomInput = await readJsonArtifact(root, segment, "bloom.bin");
  const bloom = validateArtifact(segment, "bloom.bin", () =>
    assertIs(
      SerializedBloomFilterGuard,
      bloomInput,
      "corruption",
      "Invalid immutable segment Bloom metadata."
    )
  );
  validateBloomMetadata(segment, metadata, bloom);

  const deleteInput = await readJsonArtifact(root, segment, "delete.bitmap");
  const deleteBitmap = validateArtifact(segment, "delete.bitmap", () =>
    assertIs(
      DeleteBitmapFileGuard,
      deleteInput,
      "corruption",
      "Invalid immutable segment delete bitmap."
    )
  );
  validateDeleteBitmap(segment, deleteBitmap, physicalDocIds);

  return {
    metadata,
    offsetTable,
    postingIndex,
    ...(scopedPostingIndex === undefined ? {} : { scopedPostingIndex }),
    deleteBitmap,
    totalByteSize
  };
}

async function artifactExists(root: string, artifact: SegmentArtifactName): Promise<boolean> {
  try {
    await stat(join(root, artifact));
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw new SabliStorageError(`Failed to inspect immutable segment artifact ${artifact}.`, { cause: error });
  }
}

async function requireRegularFile(
  root: string,
  segment: string,
  artifact: SegmentArtifactName
): Promise<number> {
  let information;
  try {
    information = await stat(join(root, artifact));
  } catch (error) {
    if (isMissingPath(error)) {
      throw segmentCorruption(segment, artifact, "required artifact is missing", error);
    }
    throw new SabliStorageError(`Failed to inspect immutable segment ${segment} artifact ${artifact}.`, { cause: error });
  }
  if (!information.isFile()) {
    throw segmentCorruption(segment, artifact, "required artifact is not a regular file");
  }
  return information.size;
}

async function assertDocumentBlockReadable(root: string, segment: string): Promise<void> {
  let handle;
  try {
    handle = await open(join(root, "docs.bin"), "r");
  } catch (error) {
    if (isMissingPath(error)) {
      throw segmentCorruption(segment, "docs.bin", "required artifact is missing", error);
    }
    throw new SabliStorageError(`Failed to read immutable segment ${segment} artifact docs.bin.`, { cause: error });
  }
  try {
    await handle.close();
  } catch (error) {
    throw new SabliStorageError(`Failed to close immutable segment ${segment} artifact docs.bin.`, { cause: error });
  }
}

async function readJsonArtifact(root: string, segment: string, artifact: SegmentArtifactName): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(root, artifact), "utf8");
  } catch (error) {
    if (isMissingPath(error)) {
      throw segmentCorruption(segment, artifact, "required artifact is missing", error);
    }
    throw new SabliStorageError(`Failed to read immutable segment ${segment} artifact ${artifact}.`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw segmentCorruption(segment, artifact, "artifact is not valid JSON", error);
  }
}

function validateArtifact<TValue>(
  segment: string,
  artifact: SegmentArtifactName,
  validate: () => TValue
): TValue {
  try {
    return validate();
  } catch (error) {
    throw segmentCorruption(segment, artifact, "persisted metadata is invalid or unsupported", error);
  }
}

function validateManifestExpectations(
  segment: string,
  metadata: SegmentMetadata,
  options: SegmentFileValidationOptions
): void {
  if (!isSafeNonNegativeInteger(Number(metadata.segmentId))) {
    throw segmentCorruption(segment, "segment.meta.json", "segmentId is outside the supported integer domain");
  }
  if (!isSafeNonNegativeInteger(metadata.docCount)) {
    throw segmentCorruption(segment, "segment.meta.json", "docCount is outside the supported integer domain");
  }
  if (!isSafeNonNegativeInteger(metadata.minDocId) || !isSafeNonNegativeInteger(metadata.maxDocId)) {
    throw segmentCorruption(segment, "segment.meta.json", "document identifier bounds are outside the supported integer domain");
  }
  if (options.expectedSegmentId !== undefined && Number(options.expectedSegmentId) !== Number(metadata.segmentId)) {
    throw segmentCorruption(segment, "segment.meta.json", "segmentId does not match the active manifest");
  }
  if (options.expectedDocumentCount !== undefined && options.expectedDocumentCount !== metadata.docCount) {
    throw segmentCorruption(segment, "segment.meta.json", "docCount does not match the active manifest");
  }
}

function validateOffsetTable(
  segment: string,
  metadata: SegmentMetadata,
  offsetTable: OffsetTableFile,
  documentBlockSize: number
): ReadonlySet<number> {
  if (offsetTable.offsets.length !== metadata.docCount) {
    throw segmentCorruption(segment, "docs.offset", "offset count does not match segment metadata docCount");
  }

  const physicalDocIds = new Set<number>();
  const ranges: { readonly offset: number; readonly end: number }[] = [];
  let minimumDocId = Number.POSITIVE_INFINITY;
  let maximumDocId = Number.NEGATIVE_INFINITY;
  for (const row of offsetTable.offsets) {
    if (!isSafePositiveInteger(row.docId)) {
      throw segmentCorruption(segment, "docs.offset", "document identifier is outside the supported integer domain");
    }
    if (physicalDocIds.has(row.docId)) {
      throw segmentCorruption(segment, "docs.offset", `duplicate physical document identifier ${String(row.docId)}`);
    }
    physicalDocIds.add(row.docId);
    minimumDocId = Math.min(minimumDocId, row.docId);
    maximumDocId = Math.max(maximumDocId, row.docId);

    if (!isSafeNonNegativeInteger(row.offset) || !isSafePositiveInteger(row.length)) {
      throw segmentCorruption(segment, "docs.offset", "document byte range is outside the supported integer domain");
    }
    const end = row.offset + row.length;
    if (!Number.isSafeInteger(end) || end > documentBlockSize) {
      throw segmentCorruption(segment, "docs.offset", "document byte range exceeds docs.bin");
    }
    ranges.push({ offset: row.offset, end });
  }

  ranges.sort((left, right) => left.offset - right.offset);
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.offset < previousEnd) {
      throw segmentCorruption(segment, "docs.offset", "document byte ranges overlap");
    }
    previousEnd = range.end;
  }

  if (physicalDocIds.size === 0) {
    if (metadata.minDocId !== 0 || metadata.maxDocId !== 0) {
      throw segmentCorruption(segment, "segment.meta.json", "empty segment document bounds must both be zero");
    }
    return physicalDocIds;
  }

  if (metadata.minDocId !== minimumDocId || metadata.maxDocId !== maximumDocId) {
    throw segmentCorruption(segment, "segment.meta.json", "document identifier bounds do not match docs.offset");
  }
  return physicalDocIds;
}

function validateUniqueStrings(
  segment: string,
  artifact: "path.dict" | "value.dict",
  values: readonly string[]
): void {
  if (new Set(values).size !== values.length) {
    throw segmentCorruption(segment, artifact, "dictionary entries must be unique");
  }
}

function validatePostingIndex(
  segment: string,
  postings: PostingIndexFileInput,
  physicalDocIds: ReadonlySet<number>
): void {
  const pathKeys = new Set<string>();
  for (const [path, docIds] of postings.pathExists) {
    if (pathKeys.has(path)) {
      throw segmentCorruption(segment, "postings.idx", `duplicate path posting key ${path}`);
    }
    pathKeys.add(path);
    validatePostingDocIds(segment, docIds, physicalDocIds);
  }

  const termKeys = new Set<string>();
  for (const [term, docIds] of postings.termPostings) {
    if (termKeys.has(term)) {
      throw segmentCorruption(segment, "postings.idx", `duplicate term posting key ${term}`);
    }
    termKeys.add(term);
    validatePostingDocIds(segment, docIds, physicalDocIds);
  }

  const numericKeys = new Set<string>();
  for (const [path, rows] of postings.numericValues) {
    if (numericKeys.has(path)) {
      throw segmentCorruption(segment, "postings.idx", `duplicate numeric posting key ${path}`);
    }
    numericKeys.add(path);
    for (const { docId } of rows) {
      if (!isSafePositiveInteger(docId) || !physicalDocIds.has(docId)) {
        throw segmentCorruption(segment, "postings.idx", `numeric posting references non-physical document ${String(docId)}`);
      }
    }
  }
}

function validateScopedPostingIndex(
  segment: string,
  postings: ScopedPostingIndexFileInput,
  physicalDocIds: ReadonlySet<number>
): void {
  const scopesByArrayPath = new Map<string, ReadonlySet<string>>();
  let previousScopeKey: string | undefined;
  for (const row of postings.scopes) {
    validateCanonicalArrayPath(segment, row.arrayPath);
    if (previousScopeKey !== undefined && compareStrings(previousScopeKey, row.arrayPath) >= 0) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "scope-universe keys must be strictly sorted and unique"
      );
    }
    previousScopeKey = row.arrayPath;
    validateScopedPostingPairs(segment, row.postings, physicalDocIds);
    scopesByArrayPath.set(row.arrayPath, new Set(row.postings.map(([docId, scopeId]) => scopedPairKey(docId, scopeId))));
  }

  let previousPathKey: string | undefined;
  for (const row of postings.pathExists) {
    validateCanonicalArrayPath(segment, row.arrayPath);
    validateCanonicalRelativePath(segment, row.relativePath);
    const key = encodeScopedPathKey(row.arrayPath, row.relativePath);
    if (previousPathKey !== undefined && compareStrings(previousPathKey, key) >= 0) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "path-exists keys must be strictly sorted and unique"
      );
    }
    previousPathKey = key;
    validateScopedPostingPairs(
      segment,
      row.postings,
      physicalDocIds,
      requireScopeUniverse(segment, scopesByArrayPath, row.arrayPath)
    );
  }

  let previousTermKey: string | undefined;
  for (const row of postings.termPostings) {
    validateCanonicalArrayPath(segment, row.arrayPath);
    validateCanonicalRelativePath(segment, row.relativePath);
    if (primitiveValueType(row.value) !== row.valueType) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "term posting valueType does not match its primitive value"
      );
    }
    if (typeof row.value === "number" && !Number.isFinite(row.value)) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "term posting values must be finite JSON numbers"
      );
    }
    const key = encodeScopedTermIdentity(row.arrayPath, row.relativePath, row.valueType, row.value);
    if (previousTermKey !== undefined && compareStrings(previousTermKey, key) >= 0) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "term posting keys must be strictly sorted and unique"
      );
    }
    previousTermKey = key;
    validateScopedPostingPairs(
      segment,
      row.postings,
      physicalDocIds,
      requireScopeUniverse(segment, scopesByArrayPath, row.arrayPath)
    );
  }

  let previousNumericKey: string | undefined;
  for (const row of postings.numericValues) {
    validateCanonicalArrayPath(segment, row.arrayPath);
    validateCanonicalRelativePath(segment, row.relativePath);
    const key = encodeScopedPathKey(row.arrayPath, row.relativePath);
    if (previousNumericKey !== undefined && compareStrings(previousNumericKey, key) >= 0) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "numeric posting keys must be strictly sorted and unique"
      );
    }
    previousNumericKey = key;
    const scopeUniverse = requireScopeUniverse(segment, scopesByArrayPath, row.arrayPath);
    let previousValue: { readonly docId: number; readonly scopeId: number; readonly value: number } | undefined;
    for (const value of row.values) {
      if (
        !isSafePositiveInteger(value.docId) ||
        !isSafePositiveInteger(value.scopeId) ||
        !physicalDocIds.has(value.docId) ||
        !Number.isFinite(value.value)
      ) {
        throw segmentCorruption(
          segment,
          SCOPED_POSTING_ARTIFACT,
          "numeric posting contains invalid identifiers or a non-finite value"
        );
      }
      if (!scopeUniverse.has(scopedPairKey(value.docId, value.scopeId))) {
        throw segmentCorruption(
          segment,
          SCOPED_POSTING_ARTIFACT,
          "numeric posting references an unknown concrete element scope"
        );
      }
      if (previousValue !== undefined && compareScopedNumericValues(previousValue, value) >= 0) {
        throw segmentCorruption(
          segment,
          SCOPED_POSTING_ARTIFACT,
          "numeric posting values must be strictly sorted and unique"
        );
      }
      previousValue = value;
    }
  }
}

function validateScopedPostingPairs(
  segment: string,
  pairs: readonly ScopedPostingPairInput[],
  physicalDocIds: ReadonlySet<number>,
  scopeUniverse?: ReadonlySet<string>
): void {
  let previous: ScopedPostingPairInput | undefined;
  for (const pair of pairs) {
    const [docId, scopeId] = pair;
    if (!isSafePositiveInteger(docId) || !isSafePositiveInteger(scopeId) || !physicalDocIds.has(docId)) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "scoped posting contains an identifier outside the physical segment domain"
      );
    }
    if (scopeUniverse !== undefined && !scopeUniverse.has(scopedPairKey(docId, scopeId))) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "scoped posting references an unknown concrete element scope"
      );
    }
    if (previous !== undefined && compareScopedPairs(previous, pair) >= 0) {
      throw segmentCorruption(
        segment,
        SCOPED_POSTING_ARTIFACT,
        "scoped posting pairs must be strictly sorted and unique"
      );
    }
    previous = pair;
  }
}

function requireScopeUniverse(
  segment: string,
  scopesByArrayPath: ReadonlyMap<string, ReadonlySet<string>>,
  arrayPath: string
): ReadonlySet<string> {
  const universe = scopesByArrayPath.get(arrayPath);
  if (universe === undefined) {
    throw segmentCorruption(
      segment,
      SCOPED_POSTING_ARTIFACT,
      `scoped posting references an unknown array path ${arrayPath}`
    );
  }
  return universe;
}

function validateCanonicalArrayPath(segment: string, path: string): void {
  let normalized: string;
  try {
    normalized = normalizeJsonPath(path);
  } catch (error) {
    throw segmentCorruption(segment, SCOPED_POSTING_ARTIFACT, "array path syntax is invalid", error);
  }
  if (normalized !== path || !path.endsWith("[]")) {
    throw segmentCorruption(
      segment,
      SCOPED_POSTING_ARTIFACT,
      "array paths must use canonical syntax and end in an array token"
    );
  }
}

function validateCanonicalRelativePath(segment: string, path: string): void {
  if (path === "$") {
    return;
  }
  let normalized: string;
  try {
    normalized = normalizeJsonPath(path);
  } catch (error) {
    throw segmentCorruption(segment, SCOPED_POSTING_ARTIFACT, "relative path syntax is invalid", error);
  }
  if (normalized !== path) {
    throw segmentCorruption(segment, SCOPED_POSTING_ARTIFACT, "relative paths must use canonical syntax");
  }
}

function primitiveValueType(value: null | boolean | number | string): "null" | "boolean" | "number" | "string" {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  return "string";
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareScopedPairs(left: ScopedPostingPairInput, right: ScopedPostingPairInput): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function compareScopedNumericValues(
  left: { readonly docId: number; readonly scopeId: number; readonly value: number },
  right: { readonly docId: number; readonly scopeId: number; readonly value: number }
): number {
  if (left.docId !== right.docId) {
    return left.docId - right.docId;
  }
  if (left.scopeId !== right.scopeId) {
    return left.scopeId - right.scopeId;
  }
  return left.value - right.value;
}

function scopedPairKey(docId: number, scopeId: number): string {
  return `${String(docId)}:${String(scopeId)}`;
}

function validatePostingDocIds(
  segment: string,
  docIds: readonly number[],
  physicalDocIds: ReadonlySet<number>
): void {
  const seen = new Set<number>();
  for (const docId of docIds) {
    if (!isSafePositiveInteger(docId) || !physicalDocIds.has(docId)) {
      throw segmentCorruption(segment, "postings.idx", `posting references non-physical document ${String(docId)}`);
    }
    if (seen.has(docId)) {
      throw segmentCorruption(segment, "postings.idx", `posting contains duplicate document ${String(docId)}`);
    }
    seen.add(docId);
  }
}

function validateBloomMetadata(
  segment: string,
  metadata: SegmentMetadata,
  bloom: {
    readonly format: "sabli-bloom";
    readonly version: 1;
    readonly bitSize: number;
    readonly hashCount: number;
    readonly data: string;
  }
): void {
  if (
    !isSafePositiveInteger(bloom.bitSize) ||
    !isSafePositiveInteger(bloom.hashCount) ||
    bloom.hashCount > bloom.bitSize
  ) {
    throw segmentCorruption(segment, "bloom.bin", "Bloom dimensions are outside the supported integer domain");
  }
  const bytes = Buffer.from(bloom.data, "base64");
  if (bytes.length !== Math.ceil(bloom.bitSize / 8) || bytes.toString("base64") !== bloom.data) {
    throw segmentCorruption(segment, "bloom.bin", "Bloom bitset encoding is invalid");
  }
  if (stableJson(bloom) !== stableJson(metadata.bloom)) {
    throw segmentCorruption(segment, "bloom.bin", "Bloom metadata does not match segment.meta.json");
  }
}

function validateDeleteBitmap(
  segment: string,
  bitmap: DeleteBitmapFileInput,
  physicalDocIds: ReadonlySet<number>
): void {
  const seen = new Set<number>();
  for (const docId of bitmap.deleted) {
    if (!isSafePositiveInteger(docId) || !physicalDocIds.has(docId)) {
      throw segmentCorruption(segment, "delete.bitmap", `deleted identifier ${String(docId)} is not a physical segment document`);
    }
    if (seen.has(docId)) {
      throw segmentCorruption(segment, "delete.bitmap", `deleted identifier ${String(docId)} is duplicated`);
    }
    seen.add(docId);
  }
}

function segmentCorruption(
  segment: string,
  artifact: string,
  detail: string,
  cause?: unknown
): SabliCorruptionError {
  const message = `Invalid immutable segment ${segment} artifact ${artifact}: ${detail}.`;
  return cause === undefined
    ? new SabliCorruptionError(message)
    : new SabliCorruptionError(message, { cause });
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
