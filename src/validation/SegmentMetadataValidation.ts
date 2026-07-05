import { SabliCorruptionError } from "../errors/index.js";
import type { SegmentMetadata } from "../segment/SegmentMetadata.js";
import { toSegmentId } from "../types/json.js";
import { checksum, stableJson } from "../storage/Checksum.js";
import { t, compile } from "typesea";
import { SerializedBloomFilterGuard } from "./schemas.js";

export const SegmentMetadataGuard = compile(t.object({
  format: t.literal("sabli-segment"),
  version: t.literal(1),
  segmentId: t.number.int().gte(0),
  docCount: t.number.int().gte(0),
  minDocId: t.number.int().gte(0),
  maxDocId: t.number.int().gte(0),
  createdAt: t.string,
  bloom: SerializedBloomFilterGuard,
  checksum: t.string
}));

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
  const result = SegmentMetadataGuard.check(input);
  if (!result.ok) {
    const issue = result.error[0];
    if (issue !== undefined && issue.path.length > 0) {
      const field = issue.path[0];
      if (field === "format" || field === "version") {
        throw new SabliCorruptionError("Invalid segment metadata: unsupported format or version.");
      }
      if (typeof field === "string" && ["segmentId", "docCount", "minDocId", "maxDocId"].includes(field)) {
        throw new SabliCorruptionError(`Invalid segment metadata: ${field} must be a non-negative integer.`);
      }
      if (field === "createdAt") {
        throw new SabliCorruptionError("Invalid segment metadata: createdAt must be an ISO timestamp.");
      }
      if (field === "bloom") {
        throw new SabliCorruptionError("Invalid segment metadata: bloom must be an object.");
      }
      if (field === "checksum") {
        throw new SabliCorruptionError("Invalid segment metadata: checksum must be a string.");
      }
    }
    throw new SabliCorruptionError(`Invalid segment metadata.`);
  }
  const record = result.value;
  if (Number.isNaN(Date.parse(record.createdAt))) {
    throw new SabliCorruptionError("Invalid segment metadata: createdAt must be an ISO timestamp.");
  }
  const payload = {
    format: record.format,
    version: record.version,
    segmentId: record.segmentId,
    docCount: record.docCount,
    minDocId: record.minDocId,
    maxDocId: record.maxDocId,
    createdAt: record.createdAt,
    bloom: record.bloom
  };
  if (checksum(stableJson(payload)) !== record.checksum) {
    throw new SabliCorruptionError("Invalid segment metadata: checksum mismatch.");
  }
  return {
    format: "sabli-segment",
    version: 1,
    segmentId: toSegmentId(record.segmentId),
    docCount: record.docCount,
    minDocId: record.minDocId,
    maxDocId: record.maxDocId,
    createdAt: record.createdAt,
    bloom: record.bloom,
    checksum: record.checksum
  };
}
