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
const path = await createBenchmarkDatabasePath("reopen", options.path);

try {
  const db = await SabliDatabase.open({ path, createIfMissing: true });
  for (let id = 1; id <= options.count; id += 1) {
    await db.insert(createBenchmarkDocument(id));
  }
  await db.close();

  const start = performance.now();
  const reopened = await SabliDatabase.open({ path, createIfMissing: false });
  const results = await reopened.search({ where: { "tags[]": { contains: "typescript" } } });
  await reopened.close();
  printMeasurement("Reopen and search benchmark", options.count, performance.now() - start);
  console.log(`Search returned ${String(results.count)} documents after reopen.`);
} finally {
  await cleanupBenchmarkDatabase(path, options.keep, options.path === undefined);
}
