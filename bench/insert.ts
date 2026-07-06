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
const path = await createBenchmarkDatabasePath("insert", options.path);

try {
  const db = await SabliDatabase.open({ path, createIfMissing: true });
  const start = performance.now();
  for (let id = 1; id <= options.count; id += 1) {
    await db.insert(createBenchmarkDocument(id));
  }
  await db.close();
  printMeasurement("Insert benchmark", options.count, performance.now() - start);
} finally {
  await cleanupBenchmarkDatabase(path, options.keep, options.path === undefined);
}
