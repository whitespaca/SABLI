import { performance } from "node:perf_hooks";
import { SabliDatabase } from "../src/index.js";
import {
  cleanupBenchmarkDatabase,
  createBenchmarkDatabasePath,
  createBenchmarkDocument,
  parseBenchOptions,
  printMeasurement
} from "./dataset.js";

const options = parseBenchOptions(process.argv.slice(2));
const path = await createBenchmarkDatabasePath("compaction", options.path);

try {
  const db = await SabliDatabase.open({ path, createIfMissing: true, memSegmentMaxDocuments: 500 });
  const inserted: number[] = [];
  for (let id = 1; id <= options.count; id += 1) {
    const result = await db.insert(createBenchmarkDocument(id));
    inserted.push(result.docId);
  }
  const mutationCount = Math.min(100, Math.floor(options.count / 10));
  for (let index = 0; index < mutationCount; index += 1) {
    await db.update(inserted[index] ?? 1, createBenchmarkDocument(options.count + index + 1));
  }
  for (let index = mutationCount; index < mutationCount * 2; index += 1) {
    const docId = inserted[index];
    if (docId !== undefined) {
      await db.delete(docId);
    }
  }

  const start = performance.now();
  await db.compact();
  const elapsed = performance.now() - start;
  const stats = await db.stats();
  await db.close();
  printMeasurement("Compaction benchmark", options.count, elapsed);
  console.log(`Compacted to ${String(stats.immutableSegmentCount)} immutable segment(s).`);
} finally {
  await cleanupBenchmarkDatabase(path, options.keep, options.path === undefined);
}
