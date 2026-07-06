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
const path = await createBenchmarkDatabasePath("search", options.path);

async function measure(db: SabliDatabase, label: string, query: Query): Promise<void> {
  for (let index = 0; index < options.warmup; index += 1) {
    await db.search(query);
  }
  const start = performance.now();
  let lastCount = 0;
  for (let index = 0; index < options.queries; index += 1) {
    lastCount = (await db.search(query)).count;
  }
  const elapsed = performance.now() - start;
  printMeasurement(label, options.queries, elapsed, "queries");
  console.log(`${label} returned ${String(lastCount)} documents on the last run.`);
}

try {
  const db = await SabliDatabase.open({ path, createIfMissing: true });
  for (let id = 1; id <= options.count; id += 1) {
    await db.insert(createBenchmarkDocument(id));
  }
  await db.flush();

  await measure(db, "Equality search benchmark", { where: { path: "metrics.shard", eq: 4 } });
  await measure(db, "Contains search benchmark", { where: { path: "tags[]", contains: "backend" } });
  await measure(db, "AND search benchmark", {
    where: {
      and: [
        { path: "tags[]", contains: "backend" },
        { path: "metrics.shard", eq: 4 }
      ]
    }
  });
  await measure(db, "Repeated cached search benchmark", { where: { path: "tags[]", contains: "typescript" } });
  const stats = await db.stats();
  console.log(`Posting cache: ${String(stats.postingCacheHits)} hits, ${String(stats.postingCacheMisses)} misses, ${String(stats.postingCacheSize)} entries.`);
  await db.close();
} finally {
  await cleanupBenchmarkDatabase(path, options.keep, options.path === undefined);
}
