export { BloomFilter } from "./bloom/bloom-filter.js";
export type { SerializedBloomFilter } from "./bloom/bloom-filter.js";
export { SabliDatabase } from "./database/SabliDatabase.js";
export type { DatabaseLifecycleState } from "./database/DatabaseLifecycle.js";
export type { SabliDatabaseStats } from "./database/DatabaseStats.js";
export {
  SabliCorruptionError,
  SabliDatabaseClosedError,
  SabliError,
  SabliLockError,
  SabliQueryError,
  SabliRecoveryError,
  SabliStorageError,
  SabliValidationError
} from "./errors/index.js";
export { SabliEngine } from "./engine/sabli-engine.js";
export { extractEntries } from "./extract/extractor.js";
export type { ExtractedEntry, ExtractedValueType } from "./extract/extractor.js";
export { MutableSegment } from "./indexes/mutable-segment.js";
export { createPostingList, SmallPostingList, SortedArrayPostingList } from "./indexes/posting.js";
export type { PostingList, PostingListOptions } from "./indexes/posting.js";
export type {
  AndExpression,
  BloomOptions,
  ElemMatchExpression,
  InsertResult,
  NotExpression,
  OrExpression,
  Query,
  QueryExpression,
  QueryPredicate,
  QueryValue,
  SabliOptions,
  SearchHit,
  SearchResult
} from "./query/ast.js";
export { planQuery } from "./query/planner.js";
export type { QueryPlan } from "./query/planner.js";
export { verifyDocument } from "./query/verifier.js";
export { MemSegment } from "./segment/MemSegment.js";
export { ImmutableSegment } from "./segment/ImmutableSegment.js";
export type { SegmentManifest } from "./segment/metadata.js";
export type { SegmentMetadata } from "./segment/SegmentMetadata.js";
export type { SabliDatabaseOptions } from "./validation/DatabaseOptionsValidation.js";
export type {
  DocId,
  JsonArray,
  JsonObject,
  JsonPath,
  JsonPrimitive,
  JsonValue,
  PathId,
  SegmentId,
  ValueId
} from "./types/json.js";
export { toDocId, toSegmentId } from "./types/json.js";
export { parseJsonDocument } from "./validation/documents.js";
export { formatValidationError } from "./validation/errors.js";
export { parseSegmentManifest } from "./validation/manifests.js";
export { parseDatabaseOptions } from "./validation/DatabaseOptionsValidation.js";
export { parseDatabaseManifest } from "./validation/ManifestValidation.js";
export { parseSabliOptions } from "./validation/options.js";
export { parseQuery } from "./validation/queries.js";
