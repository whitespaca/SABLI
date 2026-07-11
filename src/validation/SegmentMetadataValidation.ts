import { SabliCorruptionError } from "../errors/index.js";
import type { SegmentMetadata } from "../segment/SegmentMetadata.js";
import { toSegmentId } from "../types/json.js";
import { checksum, stableJson } from "../storage/Checksum.js";
import { t, compile } from "typesea";
import { SerializedBloomFilterGuard } from "./schemas.js";
import { assertValid } from "./assertValid.js";
import { MAX_SEGMENT_LEVEL } from "../maintenance/CompactionPolicy.js";

const commonSegmentMetadataFields = {
  format: t.literal("sabli-segment"),
  segmentId: t.number.int().gte(0),
  docCount: t.number.int().gte(0),
  minDocId: t.number.int().gte(0),
  maxDocId: t.number.int().gte(0),
  createdAt: t.string,
  bloom: SerializedBloomFilterGuard,
  checksum: t.string
};

export const SegmentMetadataGuard = compile(t.union(
  t.strictObject({ ...commonSegmentMetadataFields, version: t.literal(1) }),
  t.strictObject({ ...commonSegmentMetadataFields, version: t.literal(2) }),
  t.strictObject({
    ...commonSegmentMetadataFields,
    version: t.literal(3),
    level: t.number.int().gte(0).lte(MAX_SEGMENT_LEVEL)
  })
), { name: "isSegmentMetadata" });

/**
 * Validates immutable segment metadata loaded from disk.
 *
 * @param input - Unknown metadata payload.
 * @returns Validated segment metadata.
 * @throws {SabliCorruptionError} If metadata is invalid.
 */
export function parseSegmentMetadata(input: unknown): SegmentMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SabliCorruptionError("Invalid segment metadata: expected an object.");
  }
  const record = assertValid(SegmentMetadataGuard, input, "corruption", "Invalid segment metadata.");
  if (Number.isNaN(Date.parse(record.createdAt))) {
    throw new SabliCorruptionError("Invalid segment metadata: createdAt must be an ISO timestamp.");
  }
  const commonPayload = {
    format: record.format,
    version: record.version,
    segmentId: record.segmentId,
    docCount: record.docCount,
    minDocId: record.minDocId,
    maxDocId: record.maxDocId,
    createdAt: record.createdAt,
    bloom: record.bloom
  };
  const payload = record.version === 3
    ? { ...commonPayload, level: record.level }
    : commonPayload;
  if (checksum(stableJson(payload)) !== record.checksum) {
    throw new SabliCorruptionError("Invalid segment metadata: checksum mismatch.");
  }
  return {
    format: "sabli-segment",
    version: record.version,
    level: record.version === 3 ? record.level : 0,
    segmentId: toSegmentId(record.segmentId),
    docCount: record.docCount,
    minDocId: record.minDocId,
    maxDocId: record.maxDocId,
    createdAt: record.createdAt,
    bloom: record.bloom,
    checksum: record.checksum
  };
}
