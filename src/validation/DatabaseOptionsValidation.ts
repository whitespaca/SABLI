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
  }).optional()
}), { name: "isSabliDatabaseOptions" });

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
  return {
    path: record.path,
    createIfMissing: record.createIfMissing ?? false,
    memSegmentMaxDocuments: record.memSegmentMaxDocuments ?? 1000,
    durability: record.durability ?? "strict",
    postingCacheMaxEntries: record.postingCache?.enabled === false ? 0 : record.postingCache?.maxEntries ?? 128
  };
}
