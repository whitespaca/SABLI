import { SabliCorruptionError, SabliRecoveryError, SabliValidationError } from "../errors/index.js";
import { formatValidationError } from "./errors.js";
import type { SabliValidationIssue } from "./ValidationResult.js";

/**
 * Boundary category used to map validation failures onto SABLI domain errors.
 */
export type ValidationBoundary = "public" | "recovery" | "corruption";

/**
 * Creates a SABLI-owned validation error for a failed boundary check.
 *
 * @param boundary - Boundary category being validated.
 * @param summary - Stable English error summary.
 * @param issues - Optional SABLI-owned diagnostic copies.
 * @returns SABLI domain error.
 */
export function createValidationError(
  boundary: ValidationBoundary,
  summary: string,
  issues?: readonly SabliValidationIssue[]
): SabliValidationError | SabliRecoveryError | SabliCorruptionError {
  const message = issues === undefined ? summary : formatValidationError(summary, issues);
  if (boundary === "public") {
    return new SabliValidationError(message);
  }
  if (boundary === "recovery") {
    return new SabliRecoveryError(message);
  }
  return new SabliCorruptionError(message);
}
