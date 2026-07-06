import type { Issue } from "typesea";

/**
 * Internal validation issue shape retained for SABLI-owned diagnostics.
 */
export interface SabliValidationIssue {
  /** JSON-style issue path. */
  readonly path: readonly (string | number)[];
  /** Stable machine-readable issue code when available. */
  readonly code: string;
  /** Expected value description when available. */
  readonly expected?: string;
  /** Actual value description when available. */
  readonly actual?: string;
  /** Human-readable issue message when available. */
  readonly message?: string;
}

/**
 * Converts TypeSea diagnostics into SABLI-owned immutable issue records.
 *
 * @param issues - TypeSea issue array.
 * @returns SABLI-owned diagnostic copies.
 */
export function copyTypeSeaIssues(issues: readonly Issue[]): readonly SabliValidationIssue[] {
  return Object.freeze(issues.map((issue) => {
    const copy: {
      path: readonly (string | number)[];
      code: string;
      expected?: string;
      actual?: string;
      message?: string;
    } = {
      path: Object.freeze([...issue.path]),
      code: issue.code
    };
    if (issue.expected !== undefined) {
      copy.expected = issue.expected;
    }
    if (issue.actual !== undefined) {
      copy.actual = issue.actual;
    }
    if (issue.message !== undefined) {
      copy.message = issue.message;
    }
    return Object.freeze(copy);
  }));
}
