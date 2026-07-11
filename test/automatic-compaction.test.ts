import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SabliDatabase, SabliValidationError } from "../src/index.js";
import {
  setCompactionFailureHookForTests,
  type CompactionFailurePoint
} from "../src/maintenance/CompactionFailureInjection.js";
import { SegmentSnapshotManager } from "../src/maintenance/SegmentSnapshotManager.js";
import type { ImmutableSegment } from "../src/segment/ImmutableSegment.js";
import { parseDatabaseManifest } from "../src/storage/ManifestStore.js";

const roots: string[] = [];
let restoreHook: (() => void) | undefined;

async function temporaryDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sabli-auto-compaction-test-"));
  roots.push(root);
  return join(root, "database.sabli");
}

afterEach(async () => {
  restoreHook?.();
  restoreHook = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function installHook(hook: (point: CompactionFailurePoint) => void | Promise<void>): void {
  restoreHook?.();
  restoreHook = setCompactionFailureHookForTests(hook);
}

async function activeManifest(databasePath: string) {
  const name = (await readFile(join(databasePath, "CURRENT"), "utf8")).trim();
  return parseDatabaseManifest(JSON.parse(await readFile(join(databasePath, name), "utf8")));
}

async function flushNamed(database: SabliDatabase, name: string, orders: unknown[] = []): Promise<void> {
  await database.insert({ name, group: "kept", orders });
  await database.flush();
}

function automaticOptions(path: string) {
  return {
    path,
    createIfMissing: true,
    automaticCompaction: {
      enabled: true,
      maxLevelZeroSegments: 2,
      maxInputSegments: 2,
      checkIntervalMs: 60_000
    }
  } as const;
}

describe("automatic compaction lifecycle", () => {
  it("is disabled by default and preserves separate L0 flushes", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open({ path, createIfMissing: true });
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    await database.waitForMaintenance();
    await expect(database.stats()).resolves.toMatchObject({
      automaticCompactionEnabled: false,
      immutableSegmentCount: 2,
      completedAutomaticCompactionCount: 0,
      segmentCountsByLevel: [{ level: 0, count: 2 }]
    });
    await database.close();
  });

  it("compacts bounded L0 groups into L1 and preserves scalar and elemMatch results", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "cross", [{ id: "A1", price: 8_000 }, { id: "A2", price: 12_000 }]);
    await flushNamed(database, "same", [{ id: "A2", price: 12_000 }]);

    await database.waitForMaintenance();
    await expect(database.stats()).resolves.toMatchObject({
      immutableSegmentCount: 1,
      completedAutomaticCompactionCount: 1,
      lastAutomaticCompactionReason: "level-zero-segment-threshold",
      segmentCountsByLevel: [{ level: 1, count: 1 }],
      pendingObsoleteSegmentCount: 0
    });
    const scalar = await database.search({ where: { path: "group", eq: "kept" } });
    expect(scalar.documents.map(({ document }) => document.name)).toEqual(["cross", "same"]);
    const scoped = await database.search({
      where: {
        path: "orders[]",
        elemMatch: { and: [{ path: "id", eq: "A2" }, { path: "price", gt: 10_000 }] }
      }
    });
    expect(scoped.documents.map(({ document }) => document.name)).toEqual(["cross", "same"]);
    const crossRejected = await database.search({
      where: {
        path: "orders[]",
        elemMatch: { and: [{ path: "id", eq: "A1" }, { path: "price", gt: 10_000 }] }
      }
    });
    expect(crossRejected.count).toBe(0);
    await database.close();

    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await expect(reopened.stats()).resolves.toMatchObject({ segmentCountsByLevel: [{ level: 1, count: 1 }] });
    await expect(reopened.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });
    await reopened.close();
  });

  it("records a pre-commit background failure and retries without changing the active manifest", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    const before = (await readFile(join(path, "CURRENT"), "utf8")).trim();
    let failed = false;
    installHook((point) => {
      if (point === "before-manifest-write" && !failed) {
        failed = true;
        throw new Error("injected pre-commit failure");
      }
    });

    await database.waitForMaintenance();
    expect((await readFile(join(path, "CURRENT"), "utf8")).trim()).toBe(before);
    await expect(database.stats()).resolves.toMatchObject({
      maintenanceState: "failed",
      failedAutomaticCompactionCount: 1,
      completedAutomaticCompactionCount: 0,
      lastMaintenanceError: "injected pre-commit failure",
      immutableSegmentCount: 2
    });
    await expect(database.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });

    restoreHook?.();
    restoreHook = undefined;
    await database.waitForMaintenance();
    await expect(database.stats()).resolves.toMatchObject({
      completedAutomaticCompactionCount: 1,
      immutableSegmentCount: 1,
      maintenanceState: "scheduled"
    });
    await database.close();
  });

  it("ignores an uncommitted manifest generation and advances monotonically on retry", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    const activeBefore = (await readFile(join(path, "CURRENT"), "utf8")).trim();
    let failed = false;
    installHook((point) => {
      if (point === "after-manifest-generation-write" && !failed) {
        failed = true;
        throw new Error("injected before CURRENT swap");
      }
    });
    await database.waitForMaintenance();
    expect((await readFile(join(path, "CURRENT"), "utf8")).trim()).toBe(activeBefore);
    const staleGeneration = (await readdir(path))
      .filter((name) => /^MANIFEST-\d{6,}$/.test(name))
      .sort()
      .at(-1);
    expect(staleGeneration).not.toBe(activeBefore);

    restoreHook?.();
    restoreHook = undefined;
    await database.waitForMaintenance();
    const activeAfter = (await readFile(join(path, "CURRENT"), "utf8")).trim();
    expect(Number(activeAfter.slice("MANIFEST-".length))).toBeGreaterThan(
      Number(staleGeneration?.slice("MANIFEST-".length))
    );
    expect((await readdir(path))).toContain(activeBefore);
    await database.close();
  });

  it("recovers the new authoritative state after a failure following the CURRENT swap", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    let failed = false;
    installHook((point) => {
      if (point === "after-current-swap" && !failed) {
        failed = true;
        throw new Error("injected after CURRENT swap");
      }
    });
    await database.waitForMaintenance();
    await expect(database.stats()).resolves.toMatchObject({
      maintenanceState: "failed",
      failedAutomaticCompactionCount: 1,
      immutableSegmentCount: 1,
      pendingObsoleteSegmentCount: 2
    });
    await expect(database.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });

    restoreHook?.();
    restoreHook = undefined;
    await database.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await expect(reopened.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });
    await expect(reopened.stats()).resolves.toMatchObject({ immutableSegmentCount: 1 });
    await reopened.close();
  });

  it("keeps the committed generation authoritative when cleanup fails", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    let failed = false;
    installHook((point) => {
      if (point === "during-obsolete-cleanup" && !failed) {
        failed = true;
        throw new Error("injected cleanup failure");
      }
    });

    await database.waitForMaintenance();
    await expect(database.stats()).resolves.toMatchObject({
      completedAutomaticCompactionCount: 1,
      immutableSegmentCount: 1,
      pendingObsoleteSegmentCount: 2,
      lastObsoleteCleanupError: "injected cleanup failure"
    });
    expect((await activeManifest(path)).segments).toHaveLength(1);
    await expect(database.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });

    restoreHook?.();
    restoreHook = undefined;
    await database.close();
    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await expect(reopened.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 2 });
    expect((await readdir(join(path, "segments"))).filter((name) => /^seg-\d{6}$/.test(name))).toHaveLength(1);
    await reopened.close();
  });

  it("serializes inserts and manual compaction behind a running automatic job", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installHook(async (point) => {
      if (point === "after-plan-selection") {
        entered();
        await barrier;
      }
    });

    const automatic = database.waitForMaintenance();
    await enteredBarrier;
    const insert = database.insert({ name: "queued", group: "kept" });
    const manual = database.compact();
    release();
    await automatic;
    await insert;
    await manual;
    await expect(database.search({ where: { path: "group", eq: "kept" } })).resolves.toMatchObject({ count: 3 });
    await expect(database.stats()).resolves.toMatchObject({ immutableSegmentCount: 1 });
    await database.close();
  });

  it("serializes update and delete visibility with disk-only automatic compaction", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    const one = await database.insert({ name: "one", group: "old" });
    await database.flush();
    const two = await database.insert({ name: "two", group: "old" });
    await database.flush();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installHook(async (point) => {
      if (point === "after-output-validation") {
        entered();
        await barrier;
      }
    });
    const maintenance = database.waitForMaintenance();
    await enteredBarrier;
    const update = database.update(one.docId, { name: "one-updated", group: "new" });
    const deletion = database.delete(two.docId);
    release();
    await maintenance;
    await Promise.all([update, deletion]);
    await expect(database.search({ where: { path: "group", eq: "old" } })).resolves.toMatchObject({ count: 0 });
    const current = await database.search({ where: { path: "group", eq: "new" } });
    expect(current.documents.map(({ document }) => document.name)).toEqual(["one-updated"]);
    await database.close();

    const reopened = await SabliDatabase.open({ path, createIfMissing: false });
    await expect(reopened.search({ where: { path: "group", eq: "old" } })).resolves.toMatchObject({ count: 0 });
    await expect(reopened.search({ where: { path: "group", eq: "new" } })).resolves.toMatchObject({ count: 1 });
    await reopened.close();
  });

  it("waits for running maintenance during close and starts no later job", async () => {
    const path = await temporaryDatabasePath();
    const database = await SabliDatabase.open(automaticOptions(path));
    await flushNamed(database, "one");
    await flushNamed(database, "two");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const enteredBarrier = new Promise<void>((resolve) => {
      entered = resolve;
    });
    installHook(async (point) => {
      if (point === "after-output-validation") {
        entered();
        await barrier;
      }
    });
    const maintenance = database.waitForMaintenance();
    await enteredBarrier;
    const close = database.close();
    let secondCloseResolved = false;
    const secondClose = database.close().then(() => {
      secondCloseResolved = true;
    });
    await Promise.resolve();
    expect(secondCloseResolved).toBe(false);
    release();
    await maintenance;
    await Promise.all([close, secondClose]);
    await expect(database.stats()).resolves.toMatchObject({ state: "closed", maintenanceState: "closing" });
    await expect(database.waitForMaintenance()).rejects.toBeInstanceOf(Error);
  });

  it("rejects invalid automatic compaction options as public validation errors", async () => {
    const path = await temporaryDatabasePath();
    const invalid = [
      { maxLevelZeroSegments: 1 },
      { maxInputSegments: 1.5 },
      { staleRatioThreshold: 0 },
      { checkIntervalMs: 0 },
      { maxInputBytes: Number.POSITIVE_INFINITY }
    ];
    for (const automaticCompaction of invalid) {
      await expect(SabliDatabase.open({ path, createIfMissing: true, automaticCompaction }))
        .rejects.toBeInstanceOf(SabliValidationError);
    }
  });
});

describe("SegmentSnapshotManager", () => {
  it("defers obsolete reader cleanup until the old generation lease is released", async () => {
    const oldSegment = { path: "segments/seg-000001" } as ImmutableSegment;
    const newSegment = { path: "segments/seg-000002" } as ImmutableSegment;
    const cleaned: string[][] = [];
    const manager = new SegmentSnapshotManager([oldSegment], (segments) => {
      cleaned.push(segments.map(({ path }) => path));
      return Promise.resolve();
    });
    const oldLease = manager.acquire();
    await manager.replace([newSegment], [oldSegment]);
    expect(oldLease.segments).toEqual([oldSegment]);
    expect(manager.segments).toEqual([newSegment]);
    expect(manager.pendingObsoleteSegmentCount).toBe(1);
    expect(cleaned).toEqual([]);
    await oldLease.release();
    expect(cleaned).toEqual([["segments/seg-000001"]]);
    expect(manager.pendingObsoleteSegmentCount).toBe(0);
  });

  it("protects a retained segment from a later generation cleanup", async () => {
    const first = { path: "segments/seg-000001" } as ImmutableSegment;
    const retained = { path: "segments/seg-000002" } as ImmutableSegment;
    const third = { path: "segments/seg-000003" } as ImmutableSegment;
    const replacement = { path: "segments/seg-000004" } as ImmutableSegment;
    const cleaned: string[][] = [];
    const manager = new SegmentSnapshotManager([first, retained], (segments) => {
      cleaned.push(segments.map(({ path }) => path));
      return Promise.resolve();
    });
    const oldestLease = manager.acquire();
    await manager.replace([retained, third], [first]);
    await manager.replace([replacement], [retained, third]);
    expect(cleaned).toEqual([]);
    expect(manager.pendingObsoleteSegmentCount).toBe(3);
    await oldestLease.release();
    expect(cleaned.flat().sort()).toEqual([
      "segments/seg-000001",
      "segments/seg-000002",
      "segments/seg-000003"
    ]);
    expect(manager.pendingObsoleteSegmentCount).toBe(0);
  });
});
