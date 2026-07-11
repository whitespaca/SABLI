import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BloomFilter,
  ImmutableSegment,
  SabliCorruptionError,
  SabliDatabase,
  SabliError,
  parseDatabaseManifest,
  toDocId,
  toSegmentId,
  type Query,
  type QueryExpression
} from "../src/index.js";
import { SegmentWriter } from "../src/segment/SegmentWriter.js";
import { checksum, stableJson } from "../src/storage/Checksum.js";
import { parseSegmentMetadata } from "../src/validation/SegmentMetadataValidation.js";
import { OffsetTableFileGuard, ScopedPostingIndexFileGuard } from "../src/validation/schemas.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sabli-integrity-test-"));
  roots.push(root);
  return root;
}

async function temporaryDatabasePath(): Promise<string> {
  return join(await temporaryRoot(), "database.sabli");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function activeSegmentPath(databasePath: string): Promise<string> {
  const manifestName = (await readFile(join(databasePath, "CURRENT"), "utf8")).trim();
  const text = await readFile(join(databasePath, manifestName), "utf8");
  const parsed: unknown = JSON.parse(text);
  const manifest = parseDatabaseManifest(parsed);
  const [entry] = manifest.segments;
  if (entry === undefined) {
    throw new Error("Expected an active immutable segment in the test database.");
  }
  return join(databasePath, entry.path);
}

async function createClosedSegmentDatabase(): Promise<{ readonly databasePath: string; readonly segmentPath: string }> {
  const databasePath = await temporaryDatabasePath();
  const database = await SabliDatabase.open({ path: databasePath, createIfMissing: true });
  await database.insert({ name: "one", group: "bitmap" });
  await database.insert({ name: "two", group: "bitmap" });
  await database.insert({ name: "three", group: "bitmap" });
  await database.flush();
  await database.close();
  return { databasePath, segmentPath: await activeSegmentPath(databasePath) };
}

async function openFailure(databasePath: string): Promise<unknown> {
  try {
    const database = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    await database.close();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

async function markActiveSegmentLegacy(databasePath: string, removeScopedPostings = true): Promise<string> {
  const segmentPath = await activeSegmentPath(databasePath);
  const metadataInput: unknown = JSON.parse(await readFile(join(segmentPath, "segment.meta.json"), "utf8"));
  const metadata = parseSegmentMetadata(metadataInput);
  const payload = {
    format: "sabli-segment" as const,
    version: 1 as const,
    segmentId: metadata.segmentId,
    docCount: metadata.docCount,
    minDocId: metadata.minDocId,
    maxDocId: metadata.maxDocId,
    createdAt: metadata.createdAt,
    bloom: metadata.bloom
  };
  await writeFile(join(segmentPath, "segment.meta.json"), JSON.stringify({
    ...payload,
    checksum: checksum(stableJson(payload))
  }));
  if (removeScopedPostings) {
    await rm(join(segmentPath, "scoped-postings.idx"));
  }
  return segmentPath;
}

async function markActiveSegmentVersion2(databasePath: string): Promise<string> {
  const segmentPath = await activeSegmentPath(databasePath);
  const metadataInput: unknown = JSON.parse(await readFile(join(segmentPath, "segment.meta.json"), "utf8"));
  const metadata = parseSegmentMetadata(metadataInput);
  const payload = {
    format: "sabli-segment" as const,
    version: 2 as const,
    segmentId: metadata.segmentId,
    docCount: metadata.docCount,
    minDocId: metadata.minDocId,
    maxDocId: metadata.maxDocId,
    createdAt: metadata.createdAt,
    bloom: metadata.bloom
  };
  await writeFile(join(segmentPath, "segment.meta.json"), JSON.stringify({
    ...payload,
    checksum: checksum(stableJson(payload))
  }));
  return segmentPath;
}

function expectCorruption(error: unknown, segmentPath: string, artifact: string): void {
  expect(error).toBeInstanceOf(SabliCorruptionError);
  if (!(error instanceof Error)) {
    throw new Error("Expected a controlled Error instance.");
  }
  expect(error).not.toBeInstanceOf(SyntaxError);
  expect(error.message).toContain(basename(segmentPath));
  expect(error.message).toContain(artifact);
  expect(error.name).not.toContain("TypeSea");
}

async function queryDocumentIds(database: SabliDatabase, query: Query): Promise<readonly number[]> {
  return (await database.search(query)).documents.map(({ docId }) => Number(docId));
}

const sparseQueries = [
  { where: { not: { path: "status", eq: "excluded" } } },
  { where: { path: "status", neq: "excluded" } },
  { where: { path: "status", exists: false } },
  { where: { path: "group", eq: "visible" } }
] as const satisfies readonly Query[];

const sparseExpectedResults = [
  [1, 5],
  [1, 5],
  [1],
  [1, 4, 5]
] as const;

async function readSparseResults(database: SabliDatabase): Promise<readonly (readonly number[])[]> {
  return Promise.all(sparseQueries.map(async (query) => queryDocumentIds(database, query)));
}

describe("sparse immutable segment candidates", () => {
  it.each([
    { label: "enabled", maxEntries: 8 },
    { label: "disabled", maxEntries: 0 }
  ])("uses exact physical identifiers with the posting cache $label", async ({ maxEntries }) => {
    const root = await temporaryRoot();
    const segmentsRoot = join(root, "segments");
    await mkdir(segmentsRoot, { recursive: true });
    const writer = new SegmentWriter(segmentsRoot, { expectedEntries: 10, falsePositiveRate: 0.01 });
    const entry = await writer.write(toSegmentId(7), {
      documents: [
        { docId: toDocId(2), document: { name: "low", status: "keep" } },
        { docId: toDocId(10), document: { name: "middle", status: "excluded" } },
        { docId: toDocId(100), document: { name: "high" } }
      ],
      lastWalSequence: 3
    });
    const segmentPath = join(root, entry.path);
    const segment = await ImmutableSegment.open(segmentPath, { postingCacheMaxEntries: maxEntries });
    const notExcluded: QueryExpression = { not: { path: "$.status", eq: "excluded" } };
    const notEqual: QueryExpression = { path: "$.status", neq: "excluded" };
    const noSelectivePosting: QueryExpression = { path: "$.status", exists: false };

    expect(segment.metadata).toMatchObject({ docCount: 3, minDocId: 2, maxDocId: 100 });
    expect((await segment.candidates(notExcluded)).toArray()).toEqual([2, 100]);
    expect((await segment.candidates(notEqual)).toArray()).toEqual([2, 10, 100]);
    expect((await segment.candidates(noSelectivePosting)).toArray()).toEqual([2, 10, 100]);

    const cachedExpression: QueryExpression = { path: "$.status", eq: "keep" };
    expect((await segment.candidates(cachedExpression)).toArray()).toEqual([2]);
    expect((await segment.candidates(cachedExpression)).toArray()).toEqual([2]);
    if (maxEntries === 0) {
      expect(segment.postingCacheStats).toMatchObject({ maxEntries: 0, size: 0, hits: 0 });
    } else {
      expect(segment.postingCacheStats.hits).toBeGreaterThan(0);
    }

    await segment.markDeleted(toDocId(2));
    expect((await segment.candidates(cachedExpression)).toArray()).toEqual([]);
    expect((await segment.candidates(notExcluded)).toArray()).toEqual([100]);
    await segment.close();

    const reopened = await ImmutableSegment.open(segmentPath, { postingCacheMaxEntries: maxEntries });
    expect((await reopened.candidates(notExcluded)).toArray()).toEqual([100]);
    expect((await reopened.candidates(notEqual)).toArray()).toEqual([10, 100]);
    expect((await reopened.candidates(noSelectivePosting)).toArray()).toEqual([10, 100]);
    await reopened.close();
  });

  it.each([
    { label: "enabled", postingCache: { maxEntries: 8 } as const },
    { label: "disabled", postingCache: { enabled: false } as const }
  ])("preserves sparse query results through delete update reopen and compaction with cache $label", async ({ postingCache }) => {
    const databasePath = await temporaryDatabasePath();
    const database = await SabliDatabase.open({ path: databasePath, createIfMissing: true, postingCache });
    await database.insert({ name: "gap-survivor", group: "visible" });
    const deleted = await database.insert({ name: "deleted", status: "keep", group: "visible" });
    const superseded = await database.insert({ name: "old", status: "old", group: "visible" });
    await database.insert({ name: "excluded", status: "excluded", group: "visible" });
    await database.flush();

    expect(await queryDocumentIds(database, sparseQueries[3])).toEqual([1, 2, 3, 4]);
    await database.delete(deleted.docId);
    expect(await queryDocumentIds(database, sparseQueries[3])).toEqual([1, 3, 4]);
    const replacement = await database.update(superseded.docId, { name: "new", status: "keep", group: "visible" });
    expect(replacement.docId).toBe(toDocId(5));

    const beforeFlush = await readSparseResults(database);
    expect(beforeFlush).toEqual(sparseExpectedResults);
    await database.flush();
    expect(await readSparseResults(database)).toEqual(beforeFlush);
    const cacheStats = await database.stats();
    if ("enabled" in postingCache) {
      expect(cacheStats).toMatchObject({ postingCacheMaxEntries: 0, postingCacheSize: 0, postingCacheHits: 0 });
    } else {
      expect(cacheStats.postingCacheHits).toBeGreaterThan(0);
    }
    await database.close();

    const reopened = await SabliDatabase.open({ path: databasePath, createIfMissing: false, postingCache });
    expect(await readSparseResults(reopened)).toEqual(beforeFlush);
    await reopened.compact();
    expect(await readSparseResults(reopened)).toEqual(beforeFlush);
    await reopened.close();

    const afterCompaction = await SabliDatabase.open({ path: databasePath, createIfMissing: false, postingCache });
    expect(await readSparseResults(afterCompaction)).toEqual(beforeFlush);
    await afterCompaction.close();

    const compactedSegment = await ImmutableSegment.open(await activeSegmentPath(databasePath));
    expect(compactedSegment.metadata).toMatchObject({ docCount: 3, minDocId: 1, maxDocId: 5 });
    expect((await compactedSegment.candidates({ not: { path: "$.status", eq: "excluded" } })).toArray()).toEqual([1, 5]);
    expect((await compactedSegment.candidates({ path: "$.status", neq: "excluded" })).toArray()).toEqual([1, 4, 5]);
    expect((await compactedSegment.candidates({ path: "$.status", exists: false })).toArray()).toEqual([1, 4, 5]);
    await compactedSegment.close();
  });
});

const requiredSegmentArtifacts = [
  "segment.meta.json",
  "docs.bin",
  "docs.offset",
  "postings.idx",
  "scoped-postings.idx",
  "bloom.bin",
  "delete.bitmap",
  "path.dict",
  "value.dict"
] as const;

const structuredSegmentArtifacts = [
  "segment.meta.json",
  "docs.offset",
  "postings.idx",
  "scoped-postings.idx",
  "bloom.bin",
  "path.dict",
  "value.dict"
] as const;

describe("immutable segment file-set validation", () => {
  it("requires an explicit level in current-format segment metadata", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const metadataPath = join(segmentPath, "segment.meta.json");
    const input: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Expected object segment metadata in the test fixture.");
    }
    const record = { ...input } as Record<string, unknown>;
    delete record.level;
    await writeFile(metadataPath, JSON.stringify(record));
    expectCorruption(await openFailure(databasePath), segmentPath, "segment.meta.json");
  });

  it("rejects a current-format segment level above the implementation bound", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const metadataPath = join(segmentPath, "segment.meta.json");
    const input: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Expected object segment metadata in the test fixture.");
    }
    const payload = { ...input } as Record<string, unknown>;
    delete payload.checksum;
    const invalidPayload = { ...payload, level: 9 };
    await writeFile(metadataPath, JSON.stringify({
      ...invalidPayload,
      checksum: checksum(stableJson(invalidPayload))
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "segment.meta.json");
  });

  it.each(requiredSegmentArtifacts)("rejects a missing required %s file", async (artifact) => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await rm(join(segmentPath, artifact));
    expectCorruption(await openFailure(databasePath), segmentPath, artifact);
  });

  it.each(structuredSegmentArtifacts)("wraps malformed %s JSON as segment corruption", async (artifact) => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, artifact), "{not-json");
    expectCorruption(await openFailure(databasePath), segmentPath, artifact);
  });

  it("rejects duplicate physical identifiers in the document offset table", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const input: unknown = JSON.parse(await readFile(join(segmentPath, "docs.offset"), "utf8"));
    if (!OffsetTableFileGuard.is(input)) {
      throw new Error("Expected the test segment to contain a valid offset table.");
    }
    const duplicateDocId = input.offsets[0]?.docId;
    if (duplicateDocId === undefined || input.offsets.length < 2) {
      throw new Error("Expected at least two physical document offsets in the test segment.");
    }
    await writeFile(join(segmentPath, "docs.offset"), JSON.stringify({
      ...input,
      offsets: input.offsets.map((row, index) => index === 1 ? { ...row, docId: duplicateDocId } : row)
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "docs.offset");
  });

  it("rejects posting identifiers that are not physical segment documents", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, "postings.idx"), JSON.stringify({
      format: "sabli-postings",
      version: 1,
      pathExists: [["$.group", [1, 99]]],
      termPostings: [],
      numericValues: []
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "postings.idx");
  });

  it("rejects Bloom metadata that disagrees with the segment metadata", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const differentBloom = new BloomFilter({ expectedEntries: 2, falsePositiveRate: 0.25 });
    differentBloom.add("different");
    await writeFile(join(segmentPath, "bloom.bin"), JSON.stringify(differentBloom.serialize()));
    expectCorruption(await openFailure(databasePath), segmentPath, "bloom.bin");
  });
});

describe("scoped posting persistence compatibility", () => {
  it("deliberately treats version-2 scoped segments without a level as L0", async () => {
    const { databasePath } = await createClosedSegmentDatabase();
    await markActiveSegmentVersion2(databasePath);
    const legacyLevel = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    await expect(legacyLevel.stats()).resolves.toMatchObject({
      immutableSegmentFormatVersions: [2],
      segmentCountsByLevel: [{ level: 0, count: 1 }]
    });
    await legacyLevel.compact();
    await expect(legacyLevel.stats()).resolves.toMatchObject({
      immutableSegmentFormatVersions: [3],
      segmentCountsByLevel: [{ level: 1, count: 1 }]
    });
    await legacyLevel.close();
  });

  const sameElementQuery = {
    where: {
      path: "orders[]",
      elemMatch: {
        and: [
          { path: "id", eq: "A1" },
          { path: "price", gt: 10_000 }
        ]
      }
    }
  } as const satisfies Query;

  const notAnyA1Query = {
    where: {
      not: {
        path: "orders[]",
        elemMatch: { path: "id", eq: "A1" }
      }
    }
  } as const satisfies Query;

  it("opens legacy segments safely and upgrades them through compaction", async () => {
    const databasePath = await temporaryDatabasePath();
    const created = await SabliDatabase.open({ path: databasePath, createIfMissing: true });
    await created.insert({
      label: "cross-element",
      orders: [
        { id: "A1", price: 8_000 },
        { id: "A2", price: 12_000 }
      ]
    });
    await created.insert({ label: "same-element", orders: [{ id: "A1", price: 12_000 }] });
    await created.insert({ label: "no-a1", orders: [{ id: "B1", price: 20_000 }] });
    await created.flush();
    await created.close();

    await markActiveSegmentLegacy(databasePath);
    const legacy = await SabliDatabase.open({
      path: databasePath,
      createIfMissing: false,
      postingCache: { maxEntries: 8 }
    });
    expect(await queryDocumentIds(legacy, { where: { path: "label", eq: "same-element" } })).toEqual([2]);
    expect(await queryDocumentIds(legacy, sameElementQuery)).toEqual([2]);
    expect(await queryDocumentIds(legacy, notAnyA1Query)).toEqual([3]);
    await expect(legacy.stats()).resolves.toMatchObject({
      immutableSegmentFormatVersion: 1,
      immutableSegmentFormatVersions: [1],
      legacyElemMatchFallbackSegmentCount: 1,
      immutableScopedArrayPostingCount: 0,
      immutableScopedPathPostingCount: 0,
      immutableScopedTermPostingCount: 0
    });

    await legacy.compact();
    expect(await queryDocumentIds(legacy, sameElementQuery)).toEqual([2]);
    expect(await queryDocumentIds(legacy, notAnyA1Query)).toEqual([3]);
    expect(await queryDocumentIds(legacy, sameElementQuery)).toEqual([2]);
    const upgradedStats = await legacy.stats();
    expect(upgradedStats).toMatchObject({
      immutableSegmentFormatVersion: 3,
      immutableSegmentFormatVersions: [3],
      legacyElemMatchFallbackSegmentCount: 0
    });
    expect(upgradedStats.immutableScopedArrayPostingCount).toBeGreaterThan(0);
    expect(upgradedStats.immutableScopedPathPostingCount).toBeGreaterThan(0);
    expect(upgradedStats.immutableScopedTermPostingCount).toBeGreaterThan(0);
    expect(upgradedStats.scopedPostingCacheHits).toBeGreaterThan(0);
    expect(upgradedStats.postingCacheSize).toBeLessThanOrEqual(upgradedStats.postingCacheMaxEntries);
    await legacy.close();

    const upgradedPath = await activeSegmentPath(databasePath);
    const scopedInput: unknown = JSON.parse(await readFile(join(upgradedPath, "scoped-postings.idx"), "utf8"));
    expect(ScopedPostingIndexFileGuard.is(scopedInput)).toBe(true);
    const reopened = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    expect(await queryDocumentIds(reopened, sameElementQuery)).toEqual([2]);
    await expect(reopened.stats()).resolves.toMatchObject({
      immutableSegmentFormatVersions: [3],
      legacyElemMatchFallbackSegmentCount: 0
    });
    await reopened.close();
  });

  it("keeps scoped cache behavior bounded and correct when disabled", async () => {
    const databasePath = await temporaryDatabasePath();
    const database = await SabliDatabase.open({
      path: databasePath,
      createIfMissing: true,
      postingCache: { enabled: false }
    });
    await database.insert({ label: "same-element", orders: [{ id: "A1", price: 12_000 }] });
    await database.flush();
    expect(await queryDocumentIds(database, sameElementQuery)).toEqual([1]);
    expect(await queryDocumentIds(database, sameElementQuery)).toEqual([1]);
    await expect(database.stats()).resolves.toMatchObject({
      postingCacheMaxEntries: 0,
      postingCacheSize: 0,
      scopedPostingCacheSize: 0,
      scopedPostingCacheHits: 0
    });
    await database.close();
  });

  it("compacts mixed legacy and current segments into one current scoped segment", async () => {
    const databasePath = await temporaryDatabasePath();
    const initial = await SabliDatabase.open({ path: databasePath, createIfMissing: true });
    await initial.insert({ label: "legacy-match", orders: [{ id: "A1", price: 12_000 }] });
    await initial.flush();
    await initial.close();
    await markActiveSegmentLegacy(databasePath);

    const mixed = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    await mixed.insert({ label: "current-match", orders: [{ id: "A1", price: 13_000 }] });
    await mixed.flush();
    await expect(mixed.stats()).resolves.toMatchObject({
      immutableSegmentCount: 2,
      immutableSegmentFormatVersions: [1, 3],
      legacyElemMatchFallbackSegmentCount: 1
    });
    expect(await queryDocumentIds(mixed, sameElementQuery)).toEqual([1, 2]);

    await mixed.compact();
    expect(await queryDocumentIds(mixed, sameElementQuery)).toEqual([1, 2]);
    await expect(mixed.stats()).resolves.toMatchObject({
      immutableSegmentCount: 1,
      immutableSegmentFormatVersions: [3],
      legacyElemMatchFallbackSegmentCount: 0
    });
    await mixed.close();

    const reopened = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    expect(await queryDocumentIds(reopened, sameElementQuery)).toEqual([1, 2]);
    await reopened.close();
  });

  it("rejects a scoped posting artifact paired with legacy metadata", async () => {
    const { databasePath } = await createClosedSegmentDatabase();
    const segmentPath = await markActiveSegmentLegacy(databasePath, false);
    expectCorruption(await openFailure(databasePath), segmentPath, "scoped-postings.idx");
  });

  it("rejects scoped postings that reference non-physical documents", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, "scoped-postings.idx"), JSON.stringify({
      format: "sabli-scoped-postings",
      version: 1,
      scopes: [{ arrayPath: "$.orders[]", postings: [[99, 1]] }],
      pathExists: [],
      termPostings: [],
      numericValues: []
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "scoped-postings.idx");
  });

  it("rejects unsorted or duplicate scoped posting pairs", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, "scoped-postings.idx"), JSON.stringify({
      format: "sabli-scoped-postings",
      version: 1,
      scopes: [{ arrayPath: "$.orders[]", postings: [[2, 1], [1, 1], [1, 1]] }],
      pathExists: [],
      termPostings: [],
      numericValues: []
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "scoped-postings.idx");
  });

  it("rejects scoped term postings outside the declared scope universe", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, "scoped-postings.idx"), JSON.stringify({
      format: "sabli-scoped-postings",
      version: 1,
      scopes: [],
      pathExists: [],
      termPostings: [{
        arrayPath: "$.orders[]",
        relativePath: "$.id",
        valueType: "string",
        value: "A1",
        postings: [[1, 1]]
      }],
      numericValues: []
    }));
    expectCorruption(await openFailure(databasePath), segmentPath, "scoped-postings.idx");
  });
});

const invalidDeleteBitmaps = [
  { label: "invalid JSON", contents: "{not-json" },
  { label: "a wrong format marker", contents: JSON.stringify({ format: "wrong", version: 1, deleted: [] }) },
  { label: "an unsupported version", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 2, deleted: [] }) },
  { label: "a non-array deleted field", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: {} }) },
  { label: "a zero document identifier", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [0] }) },
  { label: "a negative document identifier", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [-1] }) },
  { label: "a fractional document identifier", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [1.5] }) },
  { label: "a duplicate document identifier", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [1, 1] }) },
  { label: "an out-of-domain document identifier", contents: JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [4] }) }
] as const;

describe("delete bitmap corruption handling", () => {
  it.each(invalidDeleteBitmaps)("rejects $label", async ({ contents }) => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    await writeFile(join(segmentPath, "delete.bitmap"), contents);
    expectCorruption(await openFailure(databasePath), segmentPath, "delete.bitmap");
  });

  it("wraps an unreadable delete bitmap path as a SABLI domain error", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const bitmapPath = join(segmentPath, "delete.bitmap");
    await rm(bitmapPath);
    await mkdir(bitmapPath);
    const error = await openFailure(databasePath);
    expect(error).toBeInstanceOf(SabliError);
    if (!(error instanceof Error)) {
      throw new Error("Expected a controlled Error instance.");
    }
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toContain(basename(segmentPath));
    expect(error.message).toContain("delete.bitmap");
  });

  it("rejects a deleted identifier in a sparse physical gap", async () => {
    const created = await createClosedSegmentDatabase();
    const database = await SabliDatabase.open({ path: created.databasePath, createIfMissing: false });
    await database.delete(toDocId(2));
    await database.compact();
    await database.close();
    const segmentPath = await activeSegmentPath(created.databasePath);
    await writeFile(join(segmentPath, "delete.bitmap"), JSON.stringify({
      format: "sabli-delete-bitmap",
      version: 1,
      deleted: [2]
    }));
    expectCorruption(await openFailure(created.databasePath), segmentPath, "delete.bitmap");
  });

  it("accepts valid empty and populated bitmaps and applies visibility on reopen", async () => {
    const { databasePath, segmentPath } = await createClosedSegmentDatabase();
    const bitmapPath = join(segmentPath, "delete.bitmap");
    await writeFile(bitmapPath, JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [] }));
    const empty = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    expect(await queryDocumentIds(empty, { where: { path: "group", eq: "bitmap" } })).toEqual([1, 2, 3]);
    await empty.close();

    await writeFile(bitmapPath, JSON.stringify({ format: "sabli-delete-bitmap", version: 1, deleted: [2] }));
    const populated = await SabliDatabase.open({ path: databasePath, createIfMissing: false });
    expect(await queryDocumentIds(populated, { where: { path: "group", eq: "bitmap" } })).toEqual([1, 3]);
    await expect(populated.stats()).resolves.toMatchObject({
      approximateDeletedDocumentCount: 1,
      validatedImmutableSegmentCount: 1,
      immutableSegmentFormatVersion: 3,
      loadedDeleteBitmapEntryCount: 1,
      exactSegmentDocumentIdCount: 3
    });
    await populated.close();
  });
});
