import { readdir, rm, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SabliDatabase, type Query } from "../src/index.js";
import {
  cleanupBenchmarkDatabase,
  createBenchmarkDatabasePath,
  createBenchmarkDocument,
  parseBenchOptions,
  printMeasurement
} from "./dataset.js";

const options = parseBenchOptions(process.argv.slice(2));
const path = await createBenchmarkDatabasePath("automatic-compaction", options.path);
const batchSize = Math.max(1, Math.ceil(options.count / 8));
const equalityQuery: Query = { where: { path: "metrics.shard", eq: 4 } };
const elemMatchQuery: Query = {
  where: {
    path: "orders[]",
    elemMatch: {
      and: [{ path: "status", eq: "paid" }, { path: "price", gte: 15_000 }]
    }
  }
};

async function insertInFlushBatches(database: SabliDatabase): Promise<number> {
  const start = performance.now();
  for (let id = 1; id <= options.count; id += 1) {
    await database.insert(createBenchmarkDocument(id));
    if (id % batchSize === 0) {
      await database.flush();
    }
  }
  await database.flush();
  return performance.now() - start;
}

async function measureSearch(database: SabliDatabase, label: string, query: Query): Promise<void> {
  for (let index = 0; index < options.warmup; index += 1) {
    await database.search(query);
  }
  const latencies: number[] = [];
  for (let index = 0; index < options.queries; index += 1) {
    const start = performance.now();
    await database.search(query);
    latencies.push(performance.now() - start);
  }
  const sorted = [...latencies].sort((left, right) => left - right);
  const elapsed = latencies.reduce((sum, latency) => sum + latency, 0);
  const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  printMeasurement(label, options.queries, elapsed, "queries");
  console.log(
    `${label} latency: average ${(elapsed / options.queries).toFixed(3)} ms, ` +
    `p50 ${percentile(0.5).toFixed(3)} ms, p95 ${percentile(0.95).toFixed(3)} ms, ` +
    `p99 ${percentile(0.99).toFixed(3)} ms.`
  );
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

try {
  const disabled = await SabliDatabase.open({ path, createIfMissing: true });
  const disabledWriteMs = await insertInFlushBatches(disabled);
  printMeasurement("Writes with automatic compaction disabled", options.count, disabledWriteMs);
  await measureSearch(disabled, "Search across accumulated L0 segments", equalityQuery);
  const disabledStats = await disabled.stats();
  console.log(`Disabled run retained ${String(disabledStats.immutableSegmentCount)} immutable segment(s).`);
  await disabled.close();
  await rm(path, { recursive: true, force: true });

  const enabled = await SabliDatabase.open({
    path,
    createIfMissing: true,
    automaticCompaction: {
      enabled: true,
      maxLevelZeroSegments: 4,
      maxInputSegments: 4,
      checkIntervalMs: 60_000
    }
  });
  const enabledWriteMs = await insertInFlushBatches(enabled);
  printMeasurement("Writes with automatic compaction enabled", options.count, enabledWriteMs);
  const bytesBefore = await directoryBytes(path);
  await measureSearch(enabled, "Search before automatic compaction", equalityQuery);
  await measureSearch(enabled, "elemMatch before automatic compaction", elemMatchQuery);
  const completedBefore = (await enabled.stats()).completedAutomaticCompactionCount;
  const compactionStart = performance.now();
  const maintenance = enabled.waitForMaintenance();
  await measureSearch(enabled, "Query latency while maintenance is active", equalityQuery);
  await maintenance;
  const compactionElapsed = performance.now() - compactionStart;
  const bytesAfter = await directoryBytes(path);
  const completedAfter = (await enabled.stats()).completedAutomaticCompactionCount;
  printMeasurement(
    "Automatic compaction",
    completedAfter - completedBefore,
    compactionElapsed,
    "maintenance runs"
  );
  await measureSearch(enabled, "Search after automatic compaction", equalityQuery);
  await measureSearch(enabled, "elemMatch after automatic compaction", elemMatchQuery);
  const enabledStats = await enabled.stats();
  console.log(
    `Automatic compaction completed ${String(enabledStats.completedAutomaticCompactionCount)} job(s); ` +
    `${String(enabledStats.immutableSegmentCount)} immutable segment(s) remain.`
  );
  console.log(`Database bytes before maintenance: ${String(bytesBefore)}; after maintenance: ${String(bytesAfter)}.`);
  await enabled.close();
} finally {
  await cleanupBenchmarkDatabase(path, options.keep, options.path === undefined);
}
