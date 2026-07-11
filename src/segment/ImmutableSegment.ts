import { join } from "node:path";
import { BloomFilter } from "../bloom/bloom-filter.js";
import { DocumentBlockReader } from "../storage/DocumentBlockStore.js";
import { writeFileAtomic } from "../storage/AtomicFile.js";
import type { DocId, JsonObject, JsonPrimitive } from "../types/json.js";
import { toDocId } from "../types/json.js";
import { createPostingList, type PostingList } from "../indexes/posting.js";
import {
  encodeScopedPathKey,
  expressionContainsElemMatch,
  isElemMatchExpression,
  resolveElemMatchExpression
} from "../indexes/scoped-index.js";
import { createScopedPostingList, type ScopedPostingEntry, type ScopedPostingList } from "../indexes/scoped-posting.js";
import type { ScopeId } from "../extract/scoped-extractor.js";
import type { QueryExpression, QueryPredicate } from "../query/ast.js";
import { encodeTermKey } from "./MemSegment.js";
import type { SegmentMetadata } from "./SegmentMetadata.js";
import { PostingCache, type PostingCacheStats } from "./PostingCache.js";
import type {
  DeleteBitmapFileInput,
  PostingIndexFileInput,
  ScopedPostingIndexFileInput,
  ScopedPostingPairInput
} from "../validation/schemas.js";
import type { OffsetTableFile } from "../storage/OffsetTable.js";
import {
  validateSegmentFileSet,
  type SegmentFileValidationOptions,
  type ValidatedSegmentFileSet
} from "./SegmentFileValidation.js";
import {
  encodeScopedPathBloomTerm,
  encodeScopedTermBloomTerm,
  encodeScopedTermIdentity
} from "./ScopedPostingIndex.js";

type PostingIndexFile = PostingIndexFileInput;

/**
 * Derived posting statistics for one immutable segment.
 */
export interface ImmutableSegmentPostingStats {
  /** Number of unique path-exists posting keys. */
  readonly pathKeyCount: number;
  /** Total path-exists posting rows. */
  readonly pathPostingCount: number;
  /** Number of unique equality or contains term posting keys. */
  readonly termKeyCount: number;
  /** Total equality or contains posting rows. */
  readonly termPostingCount: number;
  /** Number of array-path scope-universe keys. */
  readonly scopedArrayKeyCount: number;
  /** Total concrete array-element scope rows. */
  readonly scopedArrayPostingCount: number;
  /** Number of scope-relative path-exists keys. */
  readonly scopedPathKeyCount: number;
  /** Total scope-relative path-exists posting rows. */
  readonly scopedPathPostingCount: number;
  /** Number of scope-relative equality or contains keys. */
  readonly scopedTermKeyCount: number;
  /** Total scope-relative equality or contains posting rows. */
  readonly scopedTermPostingCount: number;
}

/**
 * Immutable disk-backed segment reader.
 */
export class ImmutableSegment {
  readonly #root: string;
  readonly #metadata: SegmentMetadata;
  readonly #bloom: BloomFilter;
  readonly #postingCache: PostingCache;
  readonly #deleted = new Set<number>();
  readonly #offsetTable: OffsetTableFile;
  readonly #postingIndex: PostingIndexFile;
  readonly #scopedPostingIndex: ScopedPostingIndexFileInput | undefined;
  readonly #allDocumentIds: PostingList;
  readonly #postingStats: ImmutableSegmentPostingStats;
  readonly #estimatedByteSize: number;
  #documents: DocumentBlockReader | undefined;

  private constructor(root: string, files: ValidatedSegmentFileSet, postingCacheMaxEntries: number) {
    this.#root = root;
    this.#metadata = files.metadata;
    this.#bloom = BloomFilter.deserialize(files.metadata.bloom);
    this.#postingCache = new PostingCache(postingCacheMaxEntries);
    this.#offsetTable = files.offsetTable;
    this.#postingIndex = files.postingIndex;
    this.#scopedPostingIndex = files.scopedPostingIndex;
    this.#allDocumentIds = createPostingList(files.offsetTable.offsets.map(({ docId }) => toDocId(docId)));
    this.#postingStats = derivePostingStats(files.postingIndex, files.scopedPostingIndex);
    this.#estimatedByteSize = files.totalByteSize;
    for (const docId of files.deleteBitmap.deleted) {
      this.#deleted.add(docId);
    }
  }

  /**
   * Opens an immutable segment from disk.
   *
   * @param root - Segment directory path.
   * @param options - Posting cache and optional manifest consistency expectations.
   * @returns Open segment reader.
   */
  public static async open(
    root: string,
    options: SegmentFileValidationOptions & { readonly postingCacheMaxEntries?: number } = {}
  ): Promise<ImmutableSegment> {
    const files = await validateSegmentFileSet(root, options);
    return new ImmutableSegment(root, files, options.postingCacheMaxEntries ?? 128);
  }

  /**
   * Segment metadata.
   */
  public get metadata(): SegmentMetadata {
    return this.#metadata;
  }

  /** Manifest-relative immutable segment directory path. */
  public get path(): string {
    return `segments/seg-${String(this.#metadata.segmentId).padStart(6, "0")}`;
  }

  /**
   * Number of physical document versions written to this segment.
   */
  public get documentCount(): number {
    return this.#metadata.docCount;
  }

  /**
   * Number of document identifiers hidden by this segment delete bitmap.
   */
  public get deletedDocumentCount(): number {
    return this.#deleted.size;
  }

  /**
   * Number of exact physical document identifiers loaded from the validated offset table.
   */
  public get exactDocumentIdCount(): number {
    return this.#allDocumentIds.size;
  }

  /** Total bytes across the validated required segment files. */
  public get estimatedByteSize(): number {
    return this.#estimatedByteSize;
  }

  /**
   * True when this legacy segment requires exact raw-document elemMatch fallback.
   */
  public get requiresElemMatchFallback(): boolean {
    return this.#scopedPostingIndex === undefined;
  }

  /**
   * Approximate number of visible documents in this segment.
   */
  public get liveDocumentCount(): number {
    return Math.max(0, this.#metadata.docCount - this.#deleted.size);
  }

  /**
   * Posting cache diagnostics for this segment.
   */
  public get postingCacheStats(): PostingCacheStats {
    return this.#postingCache.stats();
  }

  /**
   * Returns derived posting statistics from the validated posting index.
   *
   * @returns Posting statistics.
   */
  public postingStats(): Promise<ImmutableSegmentPostingStats> {
    return Promise.resolve(this.#postingStats);
  }

  /**
   * Generates candidate documents for a query expression.
   *
   * @param expression - Normalized query expression.
   * @returns Candidate document identifiers.
   */
  public async candidates(expression: QueryExpression): Promise<PostingList> {
    return this.candidatesForExpression(expression);
  }

  /**
   * Reads one raw document by identifier.
   *
   * @param docId - Document identifier.
   * @returns Raw document or undefined.
   */
  public async getDocument(docId: DocId): Promise<JsonObject | undefined> {
    if (this.isDeleted(docId)) {
      return undefined;
    }
    const reader = this.documentReader();
    return reader.read(docId);
  }

  /**
   * Reads all currently visible documents from this immutable segment.
   *
   * @returns Visible documents paired with their document identifiers.
   */
  public async readLiveDocuments(): Promise<readonly { readonly docId: DocId; readonly document: JsonObject }[]> {
    const reader = this.documentReader();
    const documents = await reader.readAll();
    return documents.filter(({ docId }) => !this.isDeleted(docId));
  }

  /**
   * Marks a document identifier deleted in this immutable segment.
   *
   * @param docId - Document identifier to tombstone.
   */
  public async markDeleted(docId: DocId): Promise<void> {
    if (!this.#allDocumentIds.has(docId)) {
      return;
    }
    const document = await this.getDocumentIgnoringDelete(docId);
    if (document === undefined) {
      return;
    }
    this.#deleted.add(Number(docId));
    await this.writeDeleteBitmap();
  }

  /**
   * Closes any open file handles.
   */
  public async close(): Promise<void> {
    if (this.#documents !== undefined) {
      await this.#documents.close();
      this.#documents = undefined;
    }
  }

  private documentReader(): DocumentBlockReader {
    if (this.#documents === undefined) {
      this.#documents = new DocumentBlockReader(join(this.#root, "docs.bin"), this.#offsetTable);
    }
    return this.#documents;
  }

  private async getDocumentIgnoringDelete(docId: DocId): Promise<JsonObject | undefined> {
    const reader = this.documentReader();
    return reader.read(docId);
  }

  private isDeleted(docId: DocId): boolean {
    return this.#deleted.has(Number(docId));
  }

  private async writeDeleteBitmap(): Promise<void> {
    const payload: DeleteBitmapFileInput = {
      format: "sabli-delete-bitmap",
      version: 1,
      deleted: [...this.#deleted].sort((left, right) => left - right)
    };
    await writeFileAtomic(join(this.#root, "delete.bitmap"), `${JSON.stringify(payload)}\n`);
  }

  private postings(): PostingIndexFile {
    return this.#postingIndex;
  }

  private allDocuments(): PostingList {
    return this.filterDeleted(this.#allDocumentIds);
  }

  private filterDeleted(posting: PostingList): PostingList {
    return createPostingList(posting.toArray().filter((docId) => !this.#deleted.has(Number(docId))));
  }

  private cachedPosting(key: string, values: () => readonly number[] | undefined): PostingList {
    const cacheKey = JSON.stringify(["document", Number(this.#metadata.segmentId), key]);
    const cached = this.#postingCache.get(cacheKey);
    if (cached !== undefined) {
      return this.filterDeleted(cached);
    }
    const raw = createPostingList((values() ?? []).map((value) => toDocId(value)));
    this.#postingCache.set(cacheKey, raw);
    return this.filterDeleted(raw);
  }

  private cachedScopedPosting(
    keyParts: readonly unknown[],
    values: () => readonly ScopedPostingPairInput[] | undefined
  ): ScopedPostingList {
    const cacheKey = JSON.stringify(["scoped", Number(this.#metadata.segmentId), ...keyParts]);
    const cached = this.#postingCache.getScoped(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = createScopedPostingList((values() ?? []).map(([docId, scopeId]): ScopedPostingEntry => ({
      docId: toDocId(docId),
      scopeId: scopeId as ScopeId
    })));
    this.#postingCache.setScoped(cacheKey, raw);
    return raw;
  }

  private scopedUniverse(arrayPath: string, postings: ScopedPostingIndexFileInput): ScopedPostingList {
    return this.cachedScopedPosting(
      ["universe", arrayPath],
      () => postings.scopes.find((row) => row.arrayPath === arrayPath)?.postings
    );
  }

  private scopedPathPosting(
    arrayPath: string,
    relativePath: string,
    postings: ScopedPostingIndexFileInput
  ): ScopedPostingList {
    if (!this.#bloom.mightContain(encodeScopedPathBloomTerm(arrayPath, relativePath))) {
      return createScopedPostingList([]);
    }
    const key = encodeScopedPathKey(arrayPath, relativePath);
    return this.cachedScopedPosting(
      ["path", arrayPath, relativePath],
      () => postings.pathExists.find((row) => encodeScopedPathKey(row.arrayPath, row.relativePath) === key)?.postings
    );
  }

  private scopedTermPosting(
    arrayPath: string,
    relativePath: string,
    value: JsonPrimitive,
    postings: ScopedPostingIndexFileInput
  ): ScopedPostingList {
    const valueType = primitiveValueType(value);
    const key = encodeScopedTermIdentity(arrayPath, relativePath, valueType, value);
    if (!this.#bloom.mightContain(encodeScopedTermBloomTerm(
      arrayPath,
      relativePath,
      valueType,
      value
    ))) {
      return createScopedPostingList([]);
    }
    return this.cachedScopedPosting(
      ["term", arrayPath, relativePath, valueType, value],
      () => postings.termPostings.find((row) =>
        encodeScopedTermIdentity(row.arrayPath, row.relativePath, row.valueType, row.value) === key
      )?.postings
    );
  }

  private scopedNumericPosting(
    arrayPath: string,
    relativePath: string,
    operatorKey: readonly unknown[],
    matches: (value: number) => boolean,
    postings: ScopedPostingIndexFileInput
  ): ScopedPostingList {
    const key = encodeScopedPathKey(arrayPath, relativePath);
    return this.cachedScopedPosting(
      ["numeric", arrayPath, relativePath, ...operatorKey],
      () => postings.numericValues
        .find((row) => encodeScopedPathKey(row.arrayPath, row.relativePath) === key)
        ?.values
        .filter(({ value }) => matches(value))
        .map(({ docId, scopeId }) => [docId, scopeId] as const)
    );
  }

  private scopedCandidatesForPredicate(
    arrayPath: string,
    predicate: QueryPredicate,
    postings: ScopedPostingIndexFileInput
  ): ScopedPostingList {
    const universe = this.scopedUniverse(arrayPath, postings);
    let candidates = universe;

    if (predicate.exists !== undefined) {
      const exists = this.scopedPathPosting(arrayPath, predicate.path, postings);
      candidates = candidates.intersect(predicate.exists ? exists : universe.difference(exists));
    }
    if ("eq" in predicate) {
      candidates = candidates.intersect(this.scopedTermPosting(arrayPath, predicate.path, predicate.eq, postings));
    }
    if ("neq" in predicate) {
      const equal = this.scopedTermPosting(arrayPath, predicate.path, predicate.neq, postings);
      candidates = candidates.intersect(universe.difference(equal));
    }
    if ("contains" in predicate) {
      candidates = candidates.intersect(
        this.scopedTermPosting(arrayPath, predicate.path, predicate.contains, postings)
      );
    }
    if (predicate.gt !== undefined) {
      const bound = predicate.gt;
      candidates = candidates.intersect(this.scopedNumericPosting(
        arrayPath,
        predicate.path,
        ["gt", bound],
        (value) => value > bound,
        postings
      ));
    }
    if (predicate.gte !== undefined) {
      const bound = predicate.gte;
      candidates = candidates.intersect(this.scopedNumericPosting(
        arrayPath,
        predicate.path,
        ["gte", bound],
        (value) => value >= bound,
        postings
      ));
    }
    if (predicate.lt !== undefined) {
      const bound = predicate.lt;
      candidates = candidates.intersect(this.scopedNumericPosting(
        arrayPath,
        predicate.path,
        ["lt", bound],
        (value) => value < bound,
        postings
      ));
    }
    if (predicate.lte !== undefined) {
      const bound = predicate.lte;
      candidates = candidates.intersect(this.scopedNumericPosting(
        arrayPath,
        predicate.path,
        ["lte", bound],
        (value) => value <= bound,
        postings
      ));
    }
    if (predicate.between !== undefined) {
      const [minimum, maximum] = predicate.between;
      candidates = candidates.intersect(this.scopedNumericPosting(
        arrayPath,
        predicate.path,
        ["between", minimum, maximum],
        (value) => value >= minimum && value <= maximum,
        postings
      ));
    }
    return candidates;
  }

  private scopedCandidatesForExpression(
    arrayPath: string,
    expression: QueryExpression,
    postings: ScopedPostingIndexFileInput
  ): ScopedPostingList {
    if (isElemMatchExpression(expression) || "not" in expression) {
      return this.scopedUniverse(arrayPath, postings);
    }
    if ("and" in expression) {
      const candidates = expression.and
        .map((child) => this.scopedCandidatesForExpression(arrayPath, child, postings))
        .sort((left, right) => left.size - right.size);
      const [first, ...rest] = candidates;
      if (first === undefined) {
        return this.scopedUniverse(arrayPath, postings);
      }
      let acc = first;
      for (const child of rest) {
        acc = acc.intersect(child);
        if (acc.size === 0) {
          break;
        }
      }
      return acc;
    }
    if ("or" in expression) {
      let acc = createScopedPostingList([]);
      for (const child of expression.or) {
        acc = acc.union(this.scopedCandidatesForExpression(arrayPath, child, postings));
      }
      return acc;
    }
    return this.scopedCandidatesForPredicate(arrayPath, expression, postings);
  }

  private candidatesForElemMatch(arrayPath: string, expression: QueryExpression): PostingList {
    if (this.#scopedPostingIndex === undefined) {
      return this.allDocuments();
    }
    const scoped = this.scopedCandidatesForExpression(arrayPath, expression, this.#scopedPostingIndex);
    return this.filterDeleted(scoped.matchingDocumentIds());
  }

  private candidatesForPredicate(predicate: QueryPredicate): PostingList {
    const postings = this.postings();
    let candidates: PostingList | undefined;
    if (predicate.exists === true) {
      candidates = this.#bloom.mightContain(`path:${predicate.path}`)
        ? this.cachedPosting(`path:${predicate.path}`, () => postings.pathExists.find(([path]) => path === predicate.path)?.[1])
        : createPostingList([]);
    }
    const equalityValue = "eq" in predicate ? predicate.eq : "contains" in predicate ? predicate.contains : undefined;
    if (equalityValue !== undefined) {
      const term = encodeTermKey(predicate.path, equalityValue);
      const equality = this.#bloom.mightContain(`term:${term}`)
        ? this.cachedPosting(`term:${term}`, () => postings.termPostings.find(([key]) => key === term)?.[1])
        : createPostingList([]);
      candidates = candidates === undefined ? equality : candidates.intersect(equality);
    }
    const numeric = this.numericCandidates(predicate, postings);
    if (numeric !== undefined) {
      candidates = candidates === undefined ? numeric : candidates.intersect(numeric);
    }
    return candidates ?? this.allDocuments();
  }

  private numericCandidates(predicate: QueryPredicate, postings: PostingIndexFile): PostingList | undefined {
    const hasNumeric =
      predicate.gt !== undefined ||
      predicate.gte !== undefined ||
      predicate.lt !== undefined ||
      predicate.lte !== undefined ||
      predicate.between !== undefined;
    if (!hasNumeric) {
      return undefined;
    }
    const rows = postings.numericValues.find(([path]) => path === predicate.path)?.[1] ?? [];
    return this.filterDeleted(createPostingList(
      rows
        .filter(({ value }) => {
          if (predicate.gt !== undefined && value <= predicate.gt) {
            return false;
          }
          if (predicate.gte !== undefined && value < predicate.gte) {
            return false;
          }
          if (predicate.lt !== undefined && value >= predicate.lt) {
            return false;
          }
          if (predicate.lte !== undefined && value > predicate.lte) {
            return false;
          }
          if (predicate.between !== undefined) {
            const [min, max] = predicate.between;
            return value >= min && value <= max;
          }
          return true;
        })
        .map(({ docId }) => toDocId(docId))
    ));
  }

  private async candidatesForExpression(expression: QueryExpression): Promise<PostingList> {
    if (isElemMatchExpression(expression)) {
      const elemMatch = resolveElemMatchExpression(expression);
      if (elemMatch === undefined) {
        return this.allDocuments();
      }
      return this.candidatesForElemMatch(elemMatch.arrayPath, elemMatch.expression);
    }
    if ("and" in expression) {
      // Segment-local cardinality ordering is applied after each child has been
      // resolved to a posting list, because disk and delete-bitmap state are
      // segment-specific and not visible to the generic query planner.
      const candidates = await Promise.all(expression.and.map((child) => this.candidatesForExpression(child)));
      candidates.sort((left, right) => left.size - right.size);
      const [first, ...rest] = candidates;
      if (first === undefined || first.size === 0) {
        return createPostingList([]);
      }
      let acc = first;
      for (const child of rest) {
        acc = acc.intersect(child);
        if (acc.size === 0) {
          return acc;
        }
      }
      return acc;
    }
    if ("or" in expression) {
      let acc: PostingList = createPostingList([]);
      for (const child of expression.or) {
        acc = acc.union(await this.candidatesForExpression(child));
      }
      return acc;
    }
    if ("not" in expression) {
      if (expressionContainsElemMatch(expression.not)) {
        return this.allDocuments();
      }
      return this.allDocuments().difference(await this.candidatesForExpression(expression.not));
    }
    return this.candidatesForPredicate(expression);
  }
}

function primitiveValueType(value: JsonPrimitive): "null" | "boolean" | "number" | "string" {
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

function derivePostingStats(
  postings: PostingIndexFileInput,
  scoped: ScopedPostingIndexFileInput | undefined
): ImmutableSegmentPostingStats {
  return {
    pathKeyCount: postings.pathExists.length,
    pathPostingCount: postings.pathExists.reduce((sum, row) => sum + row[1].length, 0),
    termKeyCount: postings.termPostings.length,
    termPostingCount: postings.termPostings.reduce((sum, row) => sum + row[1].length, 0),
    scopedArrayKeyCount: scoped?.scopes.length ?? 0,
    scopedArrayPostingCount: scoped?.scopes.reduce((sum, row) => sum + row.postings.length, 0) ?? 0,
    scopedPathKeyCount: scoped?.pathExists.length ?? 0,
    scopedPathPostingCount: scoped?.pathExists.reduce((sum, row) => sum + row.postings.length, 0) ?? 0,
    scopedTermKeyCount: scoped?.termPostings.length ?? 0,
    scopedTermPostingCount: scoped?.termPostings.reduce((sum, row) => sum + row.postings.length, 0) ?? 0
  };
}
