import { SabliCorruptionError } from "../errors/index.js";
import type { SegmentManifest } from "../segment/metadata.js";
import { toSegmentId } from "../types/json.js";
import { assertValid } from "./assertValid.js";
import { SegmentManifestInputGuard } from "./schemas.js";

/**
 * Validates persisted segment metadata before it is trusted by the storage layer.
 *
 * @param input - Unknown metadata read from disk.
 * @returns The validated segment manifest.
 * @throws {SabliCorruptionError} If the manifest is malformed or unsupported.
 */
export function parseSegmentManifest(input: unknown): SegmentManifest {
  const object = assertValid(SegmentManifestInputGuard, input, "corruption", "Invalid segment manifest.");
  if (Number.isNaN(Date.parse(object.createdAt))) {
    throw new SabliCorruptionError("Invalid segment manifest: createdAt must be an ISO date string.");
  }
  return {
    format: "sabli-segment",
    version: 1,
    segmentId: toSegmentId(object.segmentId),
    docCount: object.docCount,
    createdAt: object.createdAt
  };
}
