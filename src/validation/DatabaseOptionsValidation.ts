import { t, compile } from "typesea";
import { SabliValidationError } from "../errors/index.js";
import { assertValid } from "./assertValid.js";

export const DatabaseOptionsGuard = compile(t.strictObject({
  path: t.string.min(1),
  createIfMissing: t.boolean.optional(),
  memSegmentMaxDocuments: t.number.int().gte(1).optional(),
  durability: t.union(t.literal("strict"), t.literal("relaxed")).optional(),
  postingCache: t.strictObject({
    enabled: t.boolean.optional(),
    maxEntries: t.number.int().gte(0).optional()
  }).optional(),
  automaticCompaction: t.strictObject({
    enabled: t.boolean.optional(),
    maxLevelZeroSegments: t.number.int().gte(2).lte(64).optional(),
    maxInputSegments: t.number.int().gte(2).lte(32).optional(),
    staleRatioThreshold: t.number.gte(0).lte(1).optional(),
    checkIntervalMs: t.number.int().gte(10).lte(86_400_000).optional(),
    maxInputBytes: t.number.int().gte(1_024).lte(17_179_869_184).optional()
  }).optional()
}), { name: "isSabliDatabaseOptions" });

/** Additive public controls for bounded automatic compaction. */
export interface AutomaticCompactionOptions {
  /** Enables bounded background maintenance. Defaults to false. */
  readonly enabled?: boolean;
  /** Same-level segment threshold that makes a group eligible. */
  readonly maxLevelZeroSegments?: number;
  /** Maximum immutable segment inputs selected for one automatic job. */
  readonly maxInputSegments?: number;
  /** Minimum deleted or superseded document ratio for a stale rewrite. */
  readonly staleRatioThreshold?: number;
  /** Minimum delay between periodic maintenance evaluations in milliseconds. */
  readonly checkIntervalMs?: number;
  /** Maximum estimated bytes selected for one automatic job. */
  readonly maxInputBytes?: number;
}

/** Fully resolved immutable automatic compaction configuration. */
export interface ResolvedAutomaticCompactionOptions {
  /** Whether automatic compaction is enabled. */
  readonly enabled: boolean;
  /** Resolved same-level segment threshold. */
  readonly maxLevelZeroSegments: number;
  /** Resolved maximum input segment count. */
  readonly maxInputSegments: number;
  /** Resolved stale-document ratio threshold. */
  readonly staleRatioThreshold: number;
  /** Resolved periodic evaluation interval in milliseconds. */
  readonly checkIntervalMs: number;
  /** Resolved estimated input-byte bound. */
  readonly maxInputBytes: number;
}

/**
 * Options used to open a SABLI database.
 */
export interface SabliDatabaseOptions {
  /** Database directory path. */
  readonly path: string;
  /** Whether to create the database directory and manifest if missing. */
  readonly createIfMissing: boolean;
  /** Number of inserted documents to keep in memory before automatic flush. */
  readonly memSegmentMaxDocuments: number;
  /** Durability mode for acknowledged writes. */
  readonly durability: "strict" | "relaxed";
  /** Maximum immutable-segment posting cache entries. Zero disables caching. */
  readonly postingCacheMaxEntries: number;
  /** Bounded automatic compaction configuration. */
  readonly automaticCompaction: ResolvedAutomaticCompactionOptions;
}

/**
 * Validates public database open options.
 *
 * @param input - Unknown options supplied by the caller.
 * @returns Validated options with defaults.
 * @throws {SabliValidationError} If options are invalid.
 */
export function parseDatabaseOptions(input: unknown): SabliDatabaseOptions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SabliValidationError("Invalid database options: expected an object.");
  }
  const record = assertValid(DatabaseOptionsGuard, input, "public", "Invalid database options.");
  const automatic = record.automaticCompaction;
  const staleRatioThreshold = automatic?.staleRatioThreshold ?? 0.3;
  if (!Number.isFinite(staleRatioThreshold) || staleRatioThreshold <= 0 || staleRatioThreshold > 1) {
    throw new SabliValidationError("Invalid database options: staleRatioThreshold must be greater than zero and at most one.");
  }
  const automaticCompaction: ResolvedAutomaticCompactionOptions = Object.freeze({
    enabled: automatic?.enabled ?? false,
    maxLevelZeroSegments: automatic?.maxLevelZeroSegments ?? 4,
    maxInputSegments: automatic?.maxInputSegments ?? 4,
    staleRatioThreshold,
    checkIntervalMs: automatic?.checkIntervalMs ?? 5_000,
    maxInputBytes: automatic?.maxInputBytes ?? 268_435_456
  });
  return Object.freeze({
    path: record.path,
    createIfMissing: record.createIfMissing ?? false,
    memSegmentMaxDocuments: record.memSegmentMaxDocuments ?? 1000,
    durability: record.durability ?? "strict",
    postingCacheMaxEntries: record.postingCache?.enabled === false ? 0 : record.postingCache?.maxEntries ?? 128,
    automaticCompaction
  });
}
