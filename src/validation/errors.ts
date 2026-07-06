import type { Issue } from "typesea";
import type { SabliValidationIssue } from "./ValidationResult.js";

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path.map((part) => (typeof part === "number" ? `[${String(part)}]` : `.${part}`)).join("")}`;
}

/**
 * Formats TypeSea diagnostics into a SABLI validation message.
 *
 * @param summary - Human-readable message prefix.
 * @param error - TypeSea diagnostic payload.
 * @returns English validation message safe for public errors.
 */
export function formatValidationError(summary: string, error: unknown): string {
  if (!Array.isArray(error) || error.length === 0) {
    return summary;
  }
  const issues = error as readonly (Issue | SabliValidationIssue)[];
  const details = issues.slice(0, 3).map((issue) => {
    const expected = issue.expected === undefined ? issue.code : issue.expected;
    const actual = issue.actual === undefined ? "unknown" : issue.actual;
    return `${formatPath(issue.path)} expected ${expected}, received ${actual}`;
  });
  return `${summary} ${details.join("; ")}.`;
}
