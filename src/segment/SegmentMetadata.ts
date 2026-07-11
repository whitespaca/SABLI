import type { SerializedBloomFilter } from "../bloom/bloom-filter.js";
import type { SegmentId } from "../types/json.js";

/**
 * Persisted immutable segment metadata.
 */
export interface SegmentMetadata {
  /** Segment metadata format marker. */
  readonly format: "sabli-segment";
  /** Segment metadata version. */
  readonly version: 1 | 2 | 3;
  /** Deterministic level in the immutable segment lifecycle. */
  readonly level: number;
  /** Segment identifier. */
  readonly segmentId: SegmentId;
  /** Number of documents in the segment. */
  readonly docCount: number;
  /** First document identifier in the segment. */
  readonly minDocId: number;
  /** Last document identifier in the segment. */
  readonly maxDocId: number;
  /** ISO timestamp when the segment was created. */
  readonly createdAt: string;
  /** Bloom filter metadata for segment pruning. */
  readonly bloom: SerializedBloomFilter;
  /** Metadata checksum. */
  readonly checksum: string;
}
