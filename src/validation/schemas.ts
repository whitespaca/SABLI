import { compile, t, type Guard } from "typesea";
import type { SerializedBloomFilter } from "../bloom/bloom-filter.js";
import type { OffsetTableFile } from "../storage/OffsetTable.js";
import type { JsonObject, JsonPrimitive, JsonValue } from "../types/json.js";

/**
 * TypeSea guard for JSON primitive values.
 */
export const JsonPrimitiveGuard: Guard<JsonPrimitive> = t.union(
  t.literal(null),
  t.boolean,
  t.number,
  t.string
);

/**
 * TypeSea guard for recursive JSON values.
 */
export const JsonValueGuard: Guard<JsonValue> = t.lazy((): Guard<JsonValue> =>
  t.union(JsonPrimitiveGuard, t.array(JsonValueGuard), t.record(JsonValueGuard))
);

/**
 * TypeSea guard for SABLI JSON document roots.
 */
export const JsonObjectGuard: Guard<JsonObject> = t.record(JsonValueGuard);

/**
 * Raw query predicate operators accepted before path normalization.
 */
export interface QueryPredicateOperatorsInput {
  readonly eq?: JsonPrimitive;
  readonly neq?: JsonPrimitive;
  readonly exists?: boolean;
  readonly contains?: JsonPrimitive;
  readonly gt?: number;
  readonly gte?: number;
  readonly lt?: number;
  readonly lte?: number;
  readonly between?: readonly [number, number];
}

/**
 * Raw path predicate accepted by public query input.
 */
export interface QueryPathPredicateInput extends QueryPredicateOperatorsInput {
  readonly path: string;
}

/**
 * Recursive public query expression input before semantic normalization.
 */
export type QueryExpressionInput =
  | { readonly and: readonly QueryExpressionInput[] }
  | { readonly or: readonly QueryExpressionInput[] }
  | { readonly not: QueryExpressionInput }
  | {
      readonly elemMatch: {
        readonly path: string;
        readonly where: QueryExpressionInput;
      };
    }
  | QueryPathPredicateInput
  | Readonly<Record<string, QueryPredicateOperatorsInput>>;

/**
 * Public query input. Callers may pass either `{ where }` or a bare expression.
 */
export type QueryInput =
  | QueryExpressionInput
  | { readonly where: QueryExpressionInput };

/**
 * Raw SABLI constructor options accepted before defaults are applied.
 */
export interface SabliOptionsInput {
  readonly mutableSegmentMaxDocuments?: number;
  readonly bloom?: {
    readonly falsePositiveRate?: number;
    readonly expectedEntries?: number;
  };
}

const queryPredicateOptionalShape = {
  eq: JsonPrimitiveGuard.optional(),
  neq: JsonPrimitiveGuard.optional(),
  exists: t.boolean.optional(),
  contains: JsonPrimitiveGuard.optional(),
  gt: t.number.optional(),
  gte: t.number.optional(),
  lt: t.number.optional(),
  lte: t.number.optional(),
  between: t.tuple([t.number, t.number]).optional()
} as const;

/**
 * TypeSea guard for raw query predicate operator objects.
 */
export const QueryPredicateOperatorsInputGuard: Guard<QueryPredicateOperatorsInput> = t.union(
  t.object({ ...queryPredicateOptionalShape, eq: JsonPrimitiveGuard }),
  t.object({ ...queryPredicateOptionalShape, neq: JsonPrimitiveGuard }),
  t.object({ ...queryPredicateOptionalShape, exists: t.boolean }),
  t.object({ ...queryPredicateOptionalShape, contains: JsonPrimitiveGuard }),
  t.object({ ...queryPredicateOptionalShape, gt: t.number }),
  t.object({ ...queryPredicateOptionalShape, gte: t.number }),
  t.object({ ...queryPredicateOptionalShape, lt: t.number }),
  t.object({ ...queryPredicateOptionalShape, lte: t.number }),
  t.object({ ...queryPredicateOptionalShape, between: t.tuple([t.number, t.number]) })
);

/**
 * TypeSea guard for raw path predicates.
 */
export const QueryPathPredicateInputGuard: Guard<QueryPathPredicateInput> = t.union(
  t.object({ path: t.string, ...queryPredicateOptionalShape, eq: JsonPrimitiveGuard }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, neq: JsonPrimitiveGuard }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, exists: t.boolean }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, contains: JsonPrimitiveGuard }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, gt: t.number }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, gte: t.number }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, lt: t.number }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, lte: t.number }),
  t.object({ path: t.string, ...queryPredicateOptionalShape, between: t.tuple([t.number, t.number]) })
);

/**
 * TypeSea guard for raw recursive query expressions.
 */
export const QueryExpressionInputGuard: Guard<QueryExpressionInput> = t.lazy((): Guard<QueryExpressionInput> =>
  t.union(
    t.object({ and: t.array(QueryExpressionInputGuard).min(1) }),
    t.object({ or: t.array(QueryExpressionInputGuard).min(1) }),
    t.object({ not: QueryExpressionInputGuard }),
    t.object({
      elemMatch: t.object({
        path: t.string,
        where: QueryExpressionInputGuard
      })
    }),
    QueryPathPredicateInputGuard,
    t.record(QueryPredicateOperatorsInputGuard)
  )
);

/**
 * Compiled TypeSea guard for public query objects before semantic normalization.
 */
export const QueryInputGuard: Guard<QueryInput> = compile(
  t.union(
    t.object({ where: QueryExpressionInputGuard }),
    QueryExpressionInputGuard
  ),
  { name: "isSabliQueryInput" }
);

/**
 * Compiled TypeSea guard for unknown public options objects before defaults are applied.
 */
export const OptionsInputGuard = compile(
  t.object({
    mutableSegmentMaxDocuments: t.number.int().gte(1).optional(),
    bloom: t.object({
      falsePositiveRate: t.number.gt(0).lt(1).optional(),
      expectedEntries: t.number.int().gte(1).optional()
    }).optional()
  }).optional(),
  { name: "isSabliOptionsInput" }
);

/**
 * TypeSea guard for a positive public document identifier.
 */
export const DocIdInputGuard = compile(
  t.number.int().gte(1),
  { name: "isSabliDocIdInput" }
);

/**
 * TypeSea guard for serialized Bloom filter data.
 */
export const SerializedBloomFilterGuard: Guard<SerializedBloomFilter> = compile(
  t.object({
    format: t.literal("sabli-bloom"),
    version: t.literal(1),
    bitSize: t.number.int().gte(1),
    hashCount: t.number.int().gte(1),
    data: t.string
  }),
  { name: "isSerializedBloomFilter" }
);

/**
 * Raw persisted segment manifest before identifier branding.
 */
export interface SegmentManifestInput {
  readonly format: "sabli-segment";
  readonly version: 1;
  readonly segmentId: number;
  readonly docCount: number;
  readonly createdAt: string;
}

/**
 * TypeSea guard for lightweight segment manifests.
 */
export const SegmentManifestInputGuard: Guard<SegmentManifestInput> = compile(
  t.object({
    format: t.literal("sabli-segment"),
    version: t.literal(1),
    segmentId: t.number.int().gte(0),
    docCount: t.number.int().gte(0),
    createdAt: t.string
  }),
  { name: "isSegmentManifestInput" }
);

/**
 * Raw database manifest segment entry before identifier branding.
 */
export interface DatabaseManifestSegmentInput {
  readonly segmentId: number;
  readonly path: string;
  readonly docCount: number;
}

/**
 * Raw database manifest before identifier branding and checksum validation.
 */
export interface DatabaseManifestInput {
  readonly format: "sabli-manifest";
  readonly version: 1;
  readonly nextDocId: number;
  readonly nextSegmentId: number;
  readonly segments: readonly DatabaseManifestSegmentInput[];
  readonly flushedWalSequence: number;
  readonly activeWalGeneration?: number;
  readonly checksum: string;
}

/**
 * TypeSea guard for persisted database manifests.
 */
export const DatabaseManifestInputGuard: Guard<DatabaseManifestInput> = compile(
  t.object({
    format: t.literal("sabli-manifest"),
    version: t.literal(1),
    nextDocId: t.number.int().gte(1),
    nextSegmentId: t.number.int().gte(1),
    segments: t.array(t.object({
      segmentId: t.number.int().gte(1),
      path: t.string.min(1),
      docCount: t.number.int().gte(0)
    })),
    flushedWalSequence: t.number.int().gte(0),
    activeWalGeneration: t.number.int().gte(1).optional(),
    checksum: t.string
  }),
  { name: "isDatabaseManifestInput" }
);

/**
 * Raw WAL insert or update record before identifier branding.
 */
export interface WalWriteRecordInput {
  readonly format: "sabli-wal-record";
  readonly version: 1;
  readonly sequence: number;
  readonly type: "insert" | "update";
  readonly docId: number;
  readonly document: JsonObject;
}

/**
 * Raw WAL delete record before identifier branding.
 */
export interface WalDeleteRecordInput {
  readonly format: "sabli-wal-record";
  readonly version: 1;
  readonly sequence: number;
  readonly type: "delete";
  readonly docId: number;
}

/**
 * Raw WAL record loaded from disk.
 */
export type WalRecordInput = WalWriteRecordInput | WalDeleteRecordInput;

/**
 * TypeSea guard for WAL record payloads.
 */
export const WalRecordInputGuard: Guard<WalRecordInput> = compile(
  t.union(
    t.object({
      format: t.literal("sabli-wal-record"),
      version: t.literal(1),
      sequence: t.number.int().gte(1),
      type: t.literal("insert"),
      docId: t.number.int().gte(1),
      document: JsonObjectGuard
    }),
    t.object({
      format: t.literal("sabli-wal-record"),
      version: t.literal(1),
      sequence: t.number.int().gte(1),
      type: t.literal("update"),
      docId: t.number.int().gte(1),
      document: JsonObjectGuard
    }),
    t.object({
      format: t.literal("sabli-wal-record"),
      version: t.literal(1),
      sequence: t.number.int().gte(1),
      type: t.literal("delete"),
      docId: t.number.int().gte(1)
    })
  ),
  { name: "isWalRecordInput" }
);

/**
 * Raw WAL envelope loaded from one log line.
 */
export interface WalEnvelopeInput {
  readonly record: WalRecordInput;
  readonly checksum: string;
}

/**
 * TypeSea guard for WAL envelopes.
 */
export const WalEnvelopeInputGuard: Guard<WalEnvelopeInput> = compile(
  t.object({
    record: WalRecordInputGuard,
    checksum: t.string
  }),
  { name: "isWalEnvelopeInput" }
);

/**
 * TypeSea guard for document offset tables.
 */
export const OffsetTableFileGuard: Guard<OffsetTableFile> = compile(
  t.object({
    format: t.literal("sabli-doc-offsets"),
    version: t.literal(1),
    offsets: t.array(t.object({
      docId: t.number.int().gte(1),
      offset: t.number.int().gte(0),
      length: t.number.int().gte(0)
    }))
  }),
  { name: "isOffsetTableFile" }
);

/**
 * Raw delete bitmap loaded from an immutable segment directory.
 */
export interface DeleteBitmapFileInput {
  readonly format: "sabli-delete-bitmap";
  readonly version: 1;
  readonly deleted: readonly number[];
}

/**
 * TypeSea guard for immutable segment delete bitmaps.
 */
export const DeleteBitmapFileGuard: Guard<DeleteBitmapFileInput> = compile(
  t.object({
    format: t.literal("sabli-delete-bitmap"),
    version: t.literal(1),
    deleted: t.array(t.number)
  }),
  { name: "isDeleteBitmapFile" }
);

/**
 * Raw persisted posting index entry for numeric predicates.
 */
export interface NumericPostingRowInput {
  readonly docId: number;
  readonly value: number;
}

/**
 * Raw persisted posting index file.
 */
export interface PostingIndexFileInput {
  readonly format: "sabli-postings";
  readonly version: 1;
  readonly pathExists: readonly (readonly [string, readonly number[]])[];
  readonly termPostings: readonly (readonly [string, readonly number[]])[];
  readonly numericValues: readonly (readonly [string, readonly NumericPostingRowInput[]])[];
}

/**
 * TypeSea guard for immutable segment posting indexes.
 */
export const PostingIndexFileGuard: Guard<PostingIndexFileInput> = compile(
  t.object({
    format: t.literal("sabli-postings"),
    version: t.literal(1),
    pathExists: t.array(t.tuple([t.string, t.array(t.number.int().gte(1))])),
    termPostings: t.array(t.tuple([t.string, t.array(t.number.int().gte(1))])),
    numericValues: t.array(t.tuple([
      t.string,
      t.array(t.object({
        docId: t.number.int().gte(1),
        value: t.number
      }))
    ]))
  }),
  { name: "isPostingIndexFile" }
);
