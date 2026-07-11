import { describe, expect, it } from "vitest";
import {
  DefaultCompactionPolicy,
  type CompactionPolicyContext,
  type CompactionSegmentInfo
} from "../src/maintenance/CompactionPolicy.js";
import { toSegmentId } from "../src/types/json.js";

const policy = new DefaultCompactionPolicy();

function segment(
  id: number,
  level = 0,
  overrides: Partial<Omit<CompactionSegmentInfo, "segmentId" | "level">> = {}
): CompactionSegmentInfo {
  return {
    segmentId: toSegmentId(id),
    level,
    createdAt: new Date(id * 1_000).toISOString(),
    documentCount: 10,
    liveDocumentCount: 10,
    deletedDocumentCount: 0,
    estimatedBytes: 1_000,
    ...overrides
  };
}

function context(overrides: Partial<CompactionPolicyContext> = {}): CompactionPolicyContext {
  return {
    maxLevelZeroSegments: 4,
    maxInputSegments: 4,
    staleRatioThreshold: 0.3,
    maxInputBytes: 10_000,
    activeSegmentIds: new Set<number>(),
    ...overrides
  };
}

describe("DefaultCompactionPolicy", () => {
  it("returns no plan below the level-zero threshold", () => {
    expect(policy.select([segment(1), segment(2), segment(3)], context())).toBeNull();
  });

  it("selects the oldest level-zero segments deterministically at the threshold", () => {
    const plan = policy.select([segment(4), segment(2), segment(1), segment(3)], context());
    expect(plan).toMatchObject({
      inputSegmentIds: [1, 2, 3, 4],
      outputLevel: 1,
      reason: "level-zero-segment-threshold",
      estimatedInputDocumentCount: 40,
      estimatedLiveDocumentCount: 40,
      estimatedInputBytes: 4_000
    });
  });

  it("respects input count and byte bounds", () => {
    const countBound = policy.select(
      [segment(1), segment(2), segment(3), segment(4)],
      context({ maxInputSegments: 2 })
    );
    expect(countBound?.inputSegmentIds).toEqual([1, 2]);

    const byteBound = policy.select(
      [segment(1), segment(2), segment(3), segment(4)],
      context({ maxInputBytes: 2_500 })
    );
    expect(byteBound?.inputSegmentIds).toEqual([1, 2]);
    expect(policy.select(
      [segment(1, 0, { estimatedBytes: 3_000 }), segment(2), segment(3), segment(4)],
      context({ maxInputBytes: 2_500 })
    )).toBeNull();
  });

  it("selects one stale segment but never loops on one clean segment", () => {
    const stale = policy.select([
      segment(1, 0, { liveDocumentCount: 6, deletedDocumentCount: 4 })
    ], context());
    expect(stale).toMatchObject({
      inputSegmentIds: [1],
      outputLevel: 1,
      reason: "stale-document-ratio",
      estimatedDeletedRatio: 0.4
    });
    expect(policy.select([segment(2)], context())).toBeNull();
  });

  it("excludes active segments and handles mixed levels deterministically", () => {
    const plan = policy.select(
      [segment(5, 1), segment(2, 0), segment(4, 1), segment(1, 0), segment(3, 1), segment(6, 1)],
      context({ activeSegmentIds: new Set([4]) })
    );
    expect(plan).toBeNull();

    const levelPlan = policy.select(
      [segment(5, 1), segment(4, 1), segment(3, 1), segment(6, 1)],
      context()
    );
    expect(levelPlan).toMatchObject({
      inputSegmentIds: [3, 4, 5, 6],
      outputLevel: 2,
      reason: "level-1-segment-threshold"
    });
  });
});
