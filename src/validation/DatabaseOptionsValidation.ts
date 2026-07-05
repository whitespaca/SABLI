import { t, compile } from "typesea";
import { SabliValidationError } from "../errors/index.js";

export const DatabaseOptionsGuard = compile(t.object({
  path: t.string.min(1),
  createIfMissing: t.boolean.optional(),
  memSegmentMaxDocuments: t.number.int().gte(1).optional(),
  durability: t.union(t.literal("strict"), t.literal("relaxed")).optional()
}));

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
  const result = DatabaseOptionsGuard.check(input);
  if (!result.ok) {
    const issue = result.error[0];
    if (issue !== undefined && issue.path.length > 0) {
      const field = issue.path[0];
      if (field === "path") {
        throw new SabliValidationError("Invalid database options: path must be a non-empty string.");
      }
      if (field === "createIfMissing") {
        throw new SabliValidationError("Invalid database options: createIfMissing must be a boolean.");
      }
      if (field === "memSegmentMaxDocuments") {
        throw new SabliValidationError("Invalid database options: memSegmentMaxDocuments must be a positive integer.");
      }
      if (field === "durability") {
        throw new SabliValidationError("Invalid database options: durability must be strict or relaxed.");
      }
    }
    throw new SabliValidationError("Invalid database options.");
  }
  const record = result.value;
  return {
    path: record.path,
    createIfMissing: record.createIfMissing ?? false,
    memSegmentMaxDocuments: record.memSegmentMaxDocuments ?? 1000,
    durability: record.durability ?? "strict"
  };
}
