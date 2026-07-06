import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "../src/index.js";

/**
 * Parsed command-line options shared by SABLI benchmark scripts.
 */
export interface BenchOptions {
  /** Number of synthetic documents to use. */
  readonly count: number;
  /** Number of measured search queries to run. */
  readonly queries: number;
  /** Number of warmup search queries to run before measurement. */
  readonly warmup: number;
  /** Whether the temporary database directory should be kept after the run. */
  readonly keep: boolean;
  /** Optional database path supplied by the caller. */
  readonly path?: string;
}

/**
 * Deterministic synthetic document used by the benchmark suite.
 *
 * @param id - One-based document number.
 * @returns JSON document with stable scalar and array fields.
 */
export function createBenchmarkDocument(id: number): JsonObject {
  const role = id % 3 === 0 ? "database" : id % 3 === 1 ? "backend" : "search";
  return {
    user: {
      id,
      name: `user-${String(id % 1000)}`,
      age: 20 + (id % 45),
      active: id % 2 === 0
    },
    tags: [role, `group-${String(id % 20)}`, id % 5 === 0 ? "typescript" : "json"],
    metrics: {
      score: (id * 17) % 1000,
      shard: id % 16
    }
  };
}

/**
 * Parses common benchmark command-line flags.
 *
 * @param args - Process argument tail.
 * @param defaultCount - Count to use when no count flag is provided.
 * @returns Parsed benchmark options.
 */
export function parseBenchOptions(args: readonly string[], defaultCount = 1000): BenchOptions {
  let count = defaultCount;
  let queries = 100;
  let warmup = 10;
  let path: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg?.startsWith("--count=")) {
      count = Number(arg.slice("--count=".length));
      continue;
    }
    if (arg === "--count") {
      count = Number(args[index + 1]);
    }
    if (arg?.startsWith("--queries=")) {
      queries = Number(arg.slice("--queries=".length));
      continue;
    }
    if (arg === "--queries") {
      queries = Number(args[index + 1]);
    }
    if (arg?.startsWith("--warmup=")) {
      warmup = Number(arg.slice("--warmup=".length));
      continue;
    }
    if (arg === "--warmup") {
      warmup = Number(args[index + 1]);
    }
    if (arg?.startsWith("--path=")) {
      path = arg.slice("--path=".length);
      continue;
    }
    if (arg === "--path") {
      path = args[index + 1];
    }
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Invalid benchmark count: expected a positive integer.");
  }
  if (!Number.isInteger(queries) || queries < 1) {
    throw new Error("Invalid benchmark queries: expected a positive integer.");
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error("Invalid benchmark warmup: expected a non-negative integer.");
  }
  return {
    count,
    queries,
    warmup,
    keep: args.includes("--keep"),
    ...(path === undefined ? {} : { path })
  };
}

/**
 * Creates a temporary database path for one benchmark run.
 *
 * @param name - Benchmark name used in the temporary directory prefix.
 * @returns Database directory path.
 */
export async function createBenchmarkDatabasePath(name: string, requestedPath?: string): Promise<string> {
  if (requestedPath !== undefined) {
    return requestedPath;
  }
  const root = await mkdtemp(join(tmpdir(), `sabli-${name}-`));
  return join(root, "database.sabli");
}

/**
 * Removes a benchmark database unless the run asked to keep it.
 *
 * @param path - Database directory path.
 * @param keep - Whether to keep the temporary directory.
 */
export async function cleanupBenchmarkDatabase(path: string, keep: boolean, removeRoot = true): Promise<void> {
  if (keep || !removeRoot) {
    console.log(`Kept benchmark database at ${path}`);
    return;
  }
  await rm(dirname(path), { recursive: true, force: true });
}

/**
 * Prints one benchmark measurement in a consistent English format.
 *
 * @param label - Measurement label.
 * @param count - Unit count used by the benchmark.
 * @param elapsedMs - Elapsed time in milliseconds.
 * @param unit - Unit label to print.
 */
export function printMeasurement(label: string, count: number, elapsedMs: number, unit = "documents"): void {
  console.log(`${label}: ${String(count)} ${unit} in ${elapsedMs.toFixed(2)} ms`);
}
