import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  SabliCorruptionError,
  SabliDatabase,
  SabliDatabaseClosedError,
  SabliRecoveryError,
  SabliStorageError,
  SabliValidationError
} from "../src/index.js";
import { checksum, stableJson } from "../src/storage/Checksum.js";
import { toDocId, toSegmentId } from "../src/types/json.js";
import type { WalRecord } from "../src/storage/WalStore.js";
import { parseDatabaseManifest } from "../src/storage/ManifestStore.js";
import { SegmentWriter } from "../src/segment/SegmentWriter.js";

const roots: string[] = [];

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sabli-test-"));
  roots.push(root);
  return join(root, "database.sabli");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encodeWal(record: WalRecord): string {
  return `${JSON.stringify({ record, checksum: checksum(stableJson(record)) })}\n`;
}

async function activeWalPath(path: string): Promise<string> {
  const manifest = await activeManifest(path);
  return join(path, `WAL-${String(manifest.activeWalGeneration).padStart(6, "0")}.log`);
}

async function activeManifest(path: string) {
  const manifestName = (await readFile(join(path, "CURRENT"), "utf8")).trim();
  return parseDatabaseManifest(JSON.parse(await readFile(join(path, manifestName), "utf8")));
}

async function segmentNames(path: string): Promise<readonly string[]> {
  return (await readdir(join(path, "segments"))).filter((name) => name.startsWith("seg-")).sort();
}

describe("SabliDatabase persistence", () => {
  it("opens a new database", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    expect(db.path).toBe(path);
    await expect(db.stats()).resolves.toMatchObject({
      path,
      state: "open",
      manifestVersion: 1,
      immutableSegmentCount: 0,
      activeWalGeneration: 1,
      checkpointSequence: 0,
      approximateLiveDocumentCount: 0,
      approximateDeletedDocumentCount: 0,
      memSegmentDocumentCount: 0,
      compactionAvailable: true
    });
    await db.close();
    await expect(db.stats()).resolves.toMatchObject({ state: "closed", compactionAvailable: false });
  });

  it("reopens an existing database", async () => {
    const path = await tempDbPath();
    await (await SabliDatabase.open({ path, createIfMissing: true })).close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await reopened.close();
  });

  it("persists inserts across reopen", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "kim", age: 31 }, tags: ["backend"] });
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    const matches = await reopened.search({ where: { "user.name": { eq: "kim" } } });
    expect(matches.count).toBe(1);
    await reopened.close();
  });

  it("replays WAL records after a process-like reopen", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "flushed" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 2,
        type: "insert",
        docId: toDocId(2),
        document: { user: { name: "wal" }, tags: ["replay"] }
      })
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    const matches = await reopened.search({ where: { "tags[]": { contains: "replay" } } });
    expect(matches.count).toBe(1);
    await reopened.close();
  });

  it("rejects an invalid manifest", async () => {
    const path = await tempDbPath();
    await (await SabliDatabase.open({ path, createIfMissing: true })).close();
    const manifestName = (await readFile(join(path, "CURRENT"), "utf8")).trim();
    await writeFile(join(path, manifestName), JSON.stringify({ format: "bad" }));
    await expect(SabliDatabase.open({ path, createIfMissing: false })).rejects.toThrow(SabliCorruptionError);
  });

  it("stops WAL replay at a corrupted trailing record", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "flushed" } });
    await db.close();
    const wal = encodeWal({
      format: "sabli-wal-record",
      version: 1,
      sequence: 2,
      type: "insert",
      docId: toDocId(2),
      document: { user: { name: "valid" } }
    });
    await writeFile(await activeWalPath(path), `${wal}{not-json`);
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    const matches = await reopened.search({ where: { "user.name": { eq: "valid" } } });
    expect(matches.count).toBe(1);
    await reopened.close();
  });

  it("flush creates an immutable segment", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "flushed" } });
    await db.flush();
    const matches = await db.search({ where: { "user.name": { eq: "flushed" } } });
    expect(matches.count).toBe(1);
    await expect(readFile(join(path, "segments", "seg-000001", "segment.meta.json"), "utf8")).resolves.toContain("sabli-segment");
    await db.close();
  });

  it("reports stats for memory and disk state", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const first = await db.insert({ user: { name: "stats-disk" } });
    await db.flush();
    const second = await db.insert({ user: { name: "stats-memory" } });
    await db.delete(first.docId);
    const stats = await db.stats();
    expect(stats.nextDocId).toBe(Number(second.docId) + 1);
    expect(stats.immutableSegmentCount).toBe(1);
    expect(stats.memSegmentDocumentCount).toBe(1);
    expect(stats.approximateLiveDocumentCount).toBe(1);
    expect(stats.approximateDeletedDocumentCount).toBe(1);
    expect(stats.immutablePathPostingKeyCount).toBeGreaterThan(0);
    expect(stats.immutableTermPostingKeyCount).toBeGreaterThan(0);
    expect(stats.postingCacheSize).toBe(0);
    await db.close();
  });

  it("records posting cache hits and misses without changing results", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, postingCache: { maxEntries: 8 } });
    await db.insert({ user: { name: "cached" }, tags: ["cache"] });
    await db.flush();
    expect((await db.search({ where: { "tags[]": { contains: "cache" } } })).count).toBe(1);
    const afterMiss = await db.stats();
    expect(afterMiss.postingCacheMisses).toBeGreaterThan(0);
    expect((await db.search({ where: { "tags[]": { contains: "cache" } } })).count).toBe(1);
    const afterHit = await db.stats();
    expect(afterHit.postingCacheHits).toBeGreaterThan(afterMiss.postingCacheHits);
    expect(afterHit.postingCacheSize).toBeLessThanOrEqual(afterHit.postingCacheMaxEntries);
    await db.close();
  });

  it("posting cache does not bypass delete bitmap filtering", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, postingCache: { maxEntries: 8 } });
    const inserted = await db.insert({ user: { name: "cached-delete" }, tags: ["cache-delete"] });
    await db.flush();
    expect((await db.search({ where: { "tags[]": { contains: "cache-delete" } } })).count).toBe(1);
    await db.delete(inserted.docId);
    expect((await db.search({ where: { "tags[]": { contains: "cache-delete" } } })).count).toBe(0);
    expect((await db.stats()).postingCacheHits).toBeGreaterThan(0);
    await db.close();
  });

  it("posting cache can be disabled", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, postingCache: { enabled: false } });
    await db.insert({ user: { name: "no-cache" }, tags: ["no-cache"] });
    await db.flush();
    await db.search({ where: { "tags[]": { contains: "no-cache" } } });
    await db.search({ where: { "tags[]": { contains: "no-cache" } } });
    const stats = await db.stats();
    expect(stats.postingCacheMaxEntries).toBe(0);
    expect(stats.postingCacheSize).toBe(0);
    expect(stats.postingCacheHits).toBe(0);
    await db.close();
  });

  it("posting cache uses a bounded LRU policy", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, postingCache: { maxEntries: 1 } });
    await db.insert({ user: { name: "lru" }, tags: ["lru"], status: "one" });
    await db.flush();
    await db.search({ where: { path: "tags[]", contains: "lru" } });
    const afterFirst = await db.stats();
    expect(afterFirst.postingCacheMisses).toBe(1);
    expect(afterFirst.postingCacheSize).toBe(1);
    await db.search({ where: { path: "status", eq: "one" } });
    const afterSecond = await db.stats();
    expect(afterSecond.postingCacheMisses).toBe(2);
    expect(afterSecond.postingCacheSize).toBe(1);
    await db.search({ where: { path: "tags[]", contains: "lru" } });
    const afterEvictedLookup = await db.stats();
    expect(afterEvictedLookup.postingCacheMisses).toBe(3);
    expect(afterEvictedLookup.postingCacheHits).toBe(0);
    await db.close();
  });

  it("posting cache entries are scoped per immutable segment", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, memSegmentMaxDocuments: 1, postingCache: { maxEntries: 4 } });
    await db.insert({ user: { name: "segment-a" }, tags: ["shared-cache"] });
    await db.insert({ user: { name: "segment-b" }, tags: ["shared-cache"] });
    expect((await db.stats()).immutableSegmentCount).toBe(2);
    await db.search({ where: { path: "tags[]", contains: "shared-cache" } });
    const afterMiss = await db.stats();
    expect(afterMiss.postingCacheMisses).toBe(2);
    expect(afterMiss.postingCacheSize).toBe(2);
    await db.search({ where: { path: "tags[]", contains: "shared-cache" } });
    const afterHit = await db.stats();
    expect(afterHit.postingCacheHits).toBe(2);
    await db.close();
  });

  it("searches both memory and disk segments", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ tags: ["backend"], user: { name: "disk" } });
    await db.flush();
    await db.insert({ tags: ["backend"], user: { name: "mem" } });
    const matches = await db.search({ where: { "tags[]": { contains: "backend" } } });
    expect(matches.documents.map((hit) => hit.document.user)).toEqual([{ name: "disk" }, { name: "mem" }]);
    await db.close();
  });

  it("does not return deleted memory documents", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "temporary" } });
    await db.delete(inserted.docId);
    const matches = await db.search({ where: { "user.name": { eq: "temporary" } } });
    expect(matches.count).toBe(0);
    await db.close();
  });

  it("does not return deleted disk segment documents", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "disk-delete" } });
    await db.flush();
    await db.delete(inserted.docId);
    const matches = await db.search({ where: { "user.name": { eq: "disk-delete" } } });
    expect(matches.count).toBe(0);
    await expect(readFile(join(path, "segments", "seg-000001", "delete.bitmap"), "utf8")).resolves.toContain(String(inserted.docId));
    await db.close();
  });

  it("persists delete across reopen", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "delete-persist" } });
    await db.flush();
    await db.delete(inserted.docId);
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    const matches = await reopened.search({ where: { "user.name": { eq: "delete-persist" } } });
    expect(matches.count).toBe(0);
    await reopened.close();
  });

  it("updates a document as a new visible version", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "old" } });
    const updated = await db.update(inserted.docId, { user: { name: "new" } });
    expect(updated.docId).not.toBe(inserted.docId);
    expect((await db.search({ where: { "user.name": { eq: "old" } } })).count).toBe(0);
    expect((await db.search({ where: { "user.name": { eq: "new" } } })).count).toBe(1);
    await db.close();
  });

  it("persists update across reopen without returning old versions", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "old-disk" } });
    await db.flush();
    await db.update(inserted.docId, { user: { name: "new-disk" } });
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "old-disk" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "new-disk" } } })).count).toBe(1);
    await reopened.close();
  });

  it("replays WAL delete state", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "wal-delete" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 2,
        type: "delete",
        docId: toDocId(1)
      })
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "wal-delete" } } })).count).toBe(0);
    await reopened.close();
  });

  it("writes update as one atomic WAL record", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const inserted = await db.insert({ user: { name: "atomic-old" } });
    await db.flush();
    const updated = await db.update(inserted.docId, { user: { name: "atomic-new" } });
    const walText = await readFile(await activeWalPath(path), "utf8");
    const lines = walText.trim().split("\n");
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0] ?? "{}") as { record?: unknown };
    expect(envelope.record).toMatchObject({
      type: "update",
      sequence: 2,
      oldDocId: inserted.docId,
      newDocId: updated.docId
    });
    expect(envelope.record).not.toHaveProperty("docId");
    await db.close();
  });

  it("replays atomic WAL update state", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "wal-old" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 2,
        type: "update",
        oldDocId: toDocId(1),
        newDocId: toDocId(2),
        document: { user: { name: "wal-new" } }
      })
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "wal-old" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "wal-new" } } })).count).toBe(1);
    await reopened.close();
  });

  it("replays update followed by delete without resurrecting either version", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "wal-update-delete-old" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      `${encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 2,
        type: "update",
        oldDocId: toDocId(1),
        newDocId: toDocId(2),
        document: { user: { name: "wal-update-delete-new" } }
      })}${encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 3,
        type: "delete",
        docId: toDocId(2)
      })}`
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "wal-update-delete-old" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "wal-update-delete-new" } } })).count).toBe(0);
    await reopened.close();
  });

  it("compacts correctly after replaying an atomic update", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "wal-compact-old" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      encodeWal({
        format: "sabli-wal-record",
        version: 1,
        sequence: 2,
        type: "update",
        oldDocId: toDocId(1),
        newDocId: toDocId(2),
        document: { user: { name: "wal-compact-new" } }
      })
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await reopened.compact();
    await reopened.close();
    const after = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await after.search({ where: { "user.name": { eq: "wal-compact-old" } } })).count).toBe(0);
    expect((await after.search({ where: { "user.name": { eq: "wal-compact-new" } } })).count).toBe(1);
    await after.close();
  });

  it("ignores a partial trailing atomic update WAL record", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "partial-update-old" } });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      '{"record":{"format":"sabli-wal-record","version":1,"sequence":2,"type":"update"'
    );
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "partial-update-old" } } })).count).toBe(1);
    expect((await reopened.search({ where: { "user.name": { eq: "partial-update-new" } } })).count).toBe(0);
    await reopened.close();
  });

  it("rejects malformed atomic update WAL records deterministically", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.close();
    const malformed = {
      format: "sabli-wal-record",
      version: 1,
      sequence: 1,
      type: "update",
      docId: 1,
      document: { user: { name: "legacy-shape" } }
    };
    await writeFile(await activeWalPath(path), `${JSON.stringify({ record: malformed, checksum: checksum(stableJson(malformed)) })}\n`);
    await expect(SabliDatabase.open({ path, createIfMissing: false })).rejects.toThrow(SabliRecoveryError);
  });

  it("prevents writes after close", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.close();
    await expect(db.insert({ closed: true })).rejects.toThrow(SabliDatabaseClosedError);
  });

  it("rejects invalid database options", async () => {
    await expect(SabliDatabase.open({ path: "", createIfMissing: true })).rejects.toThrow(SabliValidationError);
  });

  it("rejects invalid queries", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await expect(db.search({ where: { and: [] } })).rejects.toThrow(SabliValidationError);
    await db.close();
  });

  it("compaction preserves visible documents and replaces old segments", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, memSegmentMaxDocuments: 1 });
    await db.insert({ user: { name: "one" }, tags: ["live"] });
    await db.insert({ user: { name: "two" }, tags: ["live"] });
    expect(await segmentNames(path)).toHaveLength(2);
    const before = await db.search({ where: { "tags[]": { contains: "live" } } });
    await db.compact();
    const after = await db.search({ where: { "tags[]": { contains: "live" } } });
    expect(after.documents).toEqual(before.documents);
    expect(await segmentNames(path)).toHaveLength(1);
    await db.close();
  });

  it("direct segment writes fail instead of overwriting existing segments", async () => {
    const path = await tempDbPath();
    await mkdir(join(path, "segments"), { recursive: true });
    const writer = new SegmentWriter(join(path, "segments"), { expectedEntries: 10, falsePositiveRate: 0.01 });
    await writer.write(toSegmentId(1), {
      documents: [{ docId: toDocId(1), document: { user: { name: "kept-segment" } } }],
      lastWalSequence: 1
    });
    const before = await readFile(join(path, "segments", "seg-000001", "segment.meta.json"), "utf8");
    await expect(writer.write(toSegmentId(1), {
      documents: [{ docId: toDocId(2), document: { user: { name: "overwrite-attempt" } } }],
      lastWalSequence: 2
    })).rejects.toThrow(SabliStorageError);
    await expect(readFile(join(path, "segments", "seg-000001", "segment.meta.json"), "utf8")).resolves.toBe(before);
    await expect(readdir(join(path, "segments"))).resolves.not.toContain("seg-000001.tmp");
  });

  it("failed segment writes do not change the active manifest", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "manifest-stable" } });
    await db.flush();
    await db.close();
    const before = await activeManifest(path);
    const writer = new SegmentWriter(join(path, "segments"), { expectedEntries: 10, falsePositiveRate: 0.01 });
    await expect(writer.write(before.segments[0]?.segmentId ?? toSegmentId(1), {
      documents: [{ docId: toDocId(99), document: { user: { name: "blocked" } } }],
      lastWalSequence: 99
    })).rejects.toThrow(SabliStorageError);
    expect(await activeManifest(path)).toEqual(before);
  });

  it("compacts an empty database without creating live segments", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.compact();
    expect(await segmentNames(path)).toHaveLength(0);
    const stats = await db.stats();
    expect(stats.immutableSegmentCount).toBe(0);
    expect(stats.approximateLiveDocumentCount).toBe(0);
    await db.close();
  });

  it("compacts a database with only a memory segment", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "memory-only" } });
    await db.compact();
    expect(await segmentNames(path)).toHaveLength(1);
    expect((await db.search({ where: { "user.name": { eq: "memory-only" } } })).count).toBe(1);
    expect((await db.stats()).memSegmentDocumentCount).toBe(0);
    await db.close();
  });

  it("repeated compaction calls preserve visible state", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, memSegmentMaxDocuments: 1 });
    await db.insert({ user: { name: "repeat" }, tags: ["stable"] });
    await db.insert({ user: { name: "repeat-two" }, tags: ["stable"] });
    const before = await db.search({ where: { "tags[]": { contains: "stable" } } });
    await db.compact();
    await db.compact();
    const after = await db.search({ where: { "tags[]": { contains: "stable" } } });
    expect(after.documents).toEqual(before.documents);
    expect(await segmentNames(path)).toHaveLength(1);
    await db.close();
  });

  it("compaction never reuses a live segment id", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true, memSegmentMaxDocuments: 1 });
    await db.insert({ user: { name: "segment-one" }, tags: ["reuse-check"] });
    await db.insert({ user: { name: "segment-two" }, tags: ["reuse-check"] });
    expect(await segmentNames(path)).toEqual(["seg-000001", "seg-000002"]);
    await db.compact();
    expect(await segmentNames(path)).toEqual(["seg-000003"]);
    await db.compact();
    expect(await segmentNames(path)).toEqual(["seg-000004"]);
    expect((await db.search({ where: { "tags[]": { contains: "reuse-check" } } })).count).toBe(2);
    await db.close();
  });

  it("compaction removes deleted documents from the compacted segment", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const deleted = await db.insert({ user: { name: "deleted" } });
    await db.insert({ user: { name: "kept" } });
    await db.flush();
    await db.delete(deleted.docId);
    await db.compact();
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "deleted" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "kept" } } })).count).toBe(1);
    await reopened.close();
  });

  it("compaction removes superseded versions after update", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const old = await db.insert({ user: { name: "old-compact" } });
    await db.flush();
    await db.update(old.docId, { user: { name: "new-compact" } });
    await db.compact();
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "old-compact" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "new-compact" } } })).count).toBe(1);
    await reopened.close();
  });

  it("update then delete followed by compaction returns no document", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const old = await db.insert({ user: { name: "gone-old" } });
    await db.flush();
    const replacement = await db.update(old.docId, { user: { name: "gone-new" } });
    await db.delete(replacement.docId);
    await db.compact();
    expect((await db.search({ where: { "user.name": { eq: "gone-old" } } })).count).toBe(0);
    expect((await db.search({ where: { "user.name": { eq: "gone-new" } } })).count).toBe(0);
    await db.close();
  });

  it("does not resurrect update-then-delete documents after reopen", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const old = await db.insert({ user: { name: "reopen-gone-old" } });
    await db.flush();
    const replacement = await db.update(old.docId, { user: { name: "reopen-gone-new" } });
    await db.delete(replacement.docId);
    await db.compact();
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "reopen-gone-old" } } })).count).toBe(0);
    expect((await reopened.search({ where: { "user.name": { eq: "reopen-gone-new" } } })).count).toBe(0);
    await reopened.close();
  });

  it("checkpoint advances and rotates WAL after compaction", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "checkpoint" } });
    await db.flush();
    const before = await activeManifest(path);
    await db.compact();
    const after = await activeManifest(path);
    expect(after.flushedWalSequence).toBeGreaterThanOrEqual(before.flushedWalSequence);
    expect(after.activeWalGeneration).toBeGreaterThan(before.activeWalGeneration);
    await db.insert({ user: { name: "after-checkpoint" } });
    await expect(readFile(await activeWalPath(path), "utf8")).resolves.toContain("after-checkpoint");
    await db.close();
  });

  it("checkpoint advances after flush and replay does not duplicate flushed records", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "no-duplicate" } });
    await db.flush();
    const manifest = await activeManifest(path);
    expect(manifest.flushedWalSequence).toBeGreaterThan(0);
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    const matches = await reopened.search({ where: { "user.name": { eq: "no-duplicate" } } });
    expect(matches.documents.map((hit) => hit.docId)).toEqual([toDocId(1)]);
    await reopened.close();
  });

  it("uses multiple WAL generations across reopen", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "generation-one" } });
    await db.flush();
    const afterFlush = await activeManifest(path);
    expect(afterFlush.activeWalGeneration).toBe(2);
    await db.insert({ user: { name: "generation-two" } });
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "generation-one" } } })).count).toBe(1);
    expect((await reopened.search({ where: { "user.name": { eq: "generation-two" } } })).count).toBe(1);
    expect((await reopened.stats()).activeWalGeneration).toBeGreaterThanOrEqual(2);
    await reopened.close();
  });

  it("returns equivalent query results across memory flush reopen update delete cache and compaction", async () => {
    const path = await tempDbPath();
    const queries = [
      { where: { "user.name": { eq: "kim" } } },
      { where: { "user.age": { exists: true } } },
      { where: { "tags[]": { contains: "backend" } } },
      { where: { path: "user.age", gte: 30 } },
      { where: { not: { path: "status", eq: "delete" } } },
      { where: { and: [{ path: "tags[]", contains: "backend" }, { path: "status", eq: "new" }] } },
      { where: { or: [{ path: "status", eq: "new" }, { path: "status", eq: "keep" }] } }
    ] as const;
    const readAll = async (db: SabliDatabase): Promise<readonly (readonly number[])[]> => Promise.all(
      queries.map(async (query) => (await db.search(query)).documents.map((hit) => Number(hit.docId)))
    );

    const db = await SabliDatabase.open({ path, createIfMissing: true });
    const first = await db.insert({ user: { name: "kim", age: 31 }, tags: ["backend", "typescript"], status: "old" });
    await db.insert({ user: { name: "lee", age: 25 }, tags: ["frontend"], status: "keep" });
    const third = await db.insert({ user: { name: "park", age: 40 }, tags: ["backend"], status: "delete" });
    const memoryBeforeMutations = await readAll(db);
    await db.flush();
    expect(await readAll(db)).toEqual(memoryBeforeMutations);
    await db.update(first.docId, { user: { name: "kim", age: 32 }, tags: ["backend", "database"], status: "new" });
    await db.delete(third.docId);
    const afterMutations = await readAll(db);
    await readAll(db);
    expect(await readAll(db)).toEqual(afterMutations);
    await db.close();

    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect(await readAll(reopened)).toEqual(afterMutations);
    await reopened.compact();
    expect(await readAll(reopened)).toEqual(afterMutations);
    await reopened.close();
    const postCompaction = await SabliDatabase.open({ path, createIfMissing: false });
    expect(await readAll(postCompaction)).toEqual(afterMutations);
    await postCompaction.close();
  });

  it("does not require obsolete WAL generations after checkpoint", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "checkpoint-only" } });
    await db.flush();
    await expect(readFile(join(path, "WAL-000001.log"), "utf8")).rejects.toThrow();
    await db.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect((await reopened.search({ where: { "user.name": { eq: "checkpoint-only" } } })).count).toBe(1);
    await reopened.close();
  });

  it("rejects WAL checksum mismatch with a controlled recovery error", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.close();
    await writeFile(
      await activeWalPath(path),
      `${JSON.stringify({
        record: {
          format: "sabli-wal-record",
          version: 1,
          sequence: 1,
          type: "insert",
          docId: 1,
          document: { user: { name: "bad-checksum" } }
        },
        checksum: "not-the-checksum"
      })}\n`
    );
    await expect(SabliDatabase.open({ path, createIfMissing: false })).rejects.toThrow(SabliRecoveryError);
  });

  it("keeps CURRENT pointing at the active manifest", async () => {
    const path = await tempDbPath();
    const db = await SabliDatabase.open({ path, createIfMissing: true });
    await db.insert({ user: { name: "current" } });
    await db.compact();
    expect((await readFile(join(path, "CURRENT"), "utf8")).trim()).toMatch(/^MANIFEST-\d{6,}$/);
    const manifest = await activeManifest(path);
    expect(manifest.segments).toHaveLength(1);
    expect(manifest.segments[0]?.path).toMatch(/^segments\/seg-\d{6}$/);
    expect(await segmentNames(path)).toEqual([manifest.segments[0]?.path.split("/").at(-1)]);
    await db.close();
  });

  it("cleans safe temporary segment directories on startup", async () => {
    const path = await tempDbPath();
    await (await SabliDatabase.open({ path, createIfMissing: true })).close();
    await mkdir(join(path, "segments", "seg-999999.tmp"), { recursive: true });
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect(await readdir(join(path, "segments"))).not.toContain("seg-999999.tmp");
    await reopened.close();
  });

  it("does not delete unknown segment directories on startup", async () => {
    const path = await tempDbPath();
    await (await SabliDatabase.open({ path, createIfMissing: true })).close();
    await mkdir(join(path, "segments", "unknown-data"), { recursive: true });
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect(await readdir(join(path, "segments"))).toContain("unknown-data");
    await reopened.close();
  });

  it("preserves unrecognized segment-like temporary directories", async () => {
    const path = await tempDbPath();
    await (await SabliDatabase.open({ path, createIfMissing: true })).close();
    await mkdir(join(path, "segments", "seg-leftover.tmp"), { recursive: true });
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    expect(await readdir(join(path, "segments"))).toContain("seg-leftover.tmp");
    await reopened.close();
  });
});
