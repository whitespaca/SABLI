import type { SegmentId } from "../types/json.js";

/** Maximum persisted segment level supported by the initial levelled policy. */
export const MAX_SEGMENT_LEVEL = 8;

/** Read-only segment facts available to the automatic compaction policy. */
export interface CompactionSegmentInfo {
  readonly segmentId: SegmentId;
  readonly level: number;
  readonly createdAt: string;
  readonly documentCount: number;
  readonly liveDocumentCount: number;
  readonly deletedDocumentCount: number;
  readonly estimatedBytes: number;
}

/** Runtime thresholds used by the deterministic compaction policy. */
export interface CompactionPolicyContext {
  readonly maxLevelZeroSegments: number;
  readonly maxInputSegments: number;
  readonly staleRatioThreshold: number;
  readonly maxInputBytes: number;
  readonly activeSegmentIds: ReadonlySet<number>;
}

/** Deterministic immutable-segment compaction selection. */
export interface CompactionPlan {
  readonly inputSegmentIds: readonly SegmentId[];
  readonly outputLevel: number;
  readonly reason: string;
  readonly estimatedInputDocumentCount: number;
  readonly estimatedLiveDocumentCount: number;
  readonly estimatedDeletedRatio: number;
  readonly estimatedInputBytes: number;
}

/** Internal automatic compaction selection contract. */
export interface CompactionPolicy {
  select(
    segments: readonly CompactionSegmentInfo[],
    context: CompactionPolicyContext
  ): CompactionPlan | null;
}

/**
 * Conservative deterministic levelled policy.
 *
 * @remarks It first reduces oversized same-level groups, starting at L0, then
 * rewrites the oldest stale segment when no count-based group is eligible.
 */
export class DefaultCompactionPolicy implements CompactionPolicy {
  public select(
    segments: readonly CompactionSegmentInfo[],
    context: CompactionPolicyContext
  ): CompactionPlan | null {
    const eligible = segments
      .filter(({ segmentId }) => !context.activeSegmentIds.has(Number(segmentId)))
      .sort(compareSegments);

    for (let level = 0; level <= MAX_SEGMENT_LEVEL; level += 1) {
      const sameLevel = eligible.filter((segment) => segment.level === level);
      if (sameLevel.length < context.maxLevelZeroSegments) {
        continue;
      }
      const selected = boundedOldestGroup(sameLevel, context);
      if (selected.length >= 2) {
        return createPlan(
          selected,
          Math.min(MAX_SEGMENT_LEVEL, level + 1),
          level === 0 ? "level-zero-segment-threshold" : `level-${String(level)}-segment-threshold`
        );
      }
    }

    const stale = eligible
      .filter((segment) => segment.documentCount > 0)
      .filter((segment) => segment.deletedDocumentCount / segment.documentCount >= context.staleRatioThreshold)
      .filter((segment) => segment.estimatedBytes <= context.maxInputBytes)
      .sort(compareSegments)[0];
    if (stale === undefined) {
      return null;
    }
    return createPlan(
      [stale],
      stale.level === 0 ? 1 : stale.level,
      "stale-document-ratio"
    );
  }
}

function boundedOldestGroup(
  segments: readonly CompactionSegmentInfo[],
  context: CompactionPolicyContext
): readonly CompactionSegmentInfo[] {
  const selected: CompactionSegmentInfo[] = [];
  let bytes = 0;
  for (const segment of segments) {
    if (selected.length >= context.maxInputSegments || bytes + segment.estimatedBytes > context.maxInputBytes) {
      break;
    }
    selected.push(segment);
    bytes += segment.estimatedBytes;
  }
  return selected;
}

function createPlan(
  segments: readonly CompactionSegmentInfo[],
  outputLevel: number,
  reason: string
): CompactionPlan {
  const documentCount = segments.reduce((sum, segment) => sum + segment.documentCount, 0);
  const liveCount = segments.reduce((sum, segment) => sum + segment.liveDocumentCount, 0);
  return Object.freeze({
    inputSegmentIds: Object.freeze(segments.map(({ segmentId }) => segmentId)),
    outputLevel,
    reason,
    estimatedInputDocumentCount: documentCount,
    estimatedLiveDocumentCount: liveCount,
    estimatedDeletedRatio: documentCount === 0 ? 0 : (documentCount - liveCount) / documentCount,
    estimatedInputBytes: segments.reduce((sum, segment) => sum + segment.estimatedBytes, 0)
  });
}

function compareSegments(left: CompactionSegmentInfo, right: CompactionSegmentInfo): number {
  if (left.level !== right.level) {
    return left.level - right.level;
  }
  return Number(left.segmentId) - Number(right.segmentId);
}
