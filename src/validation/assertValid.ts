import type { Guard, Presence, RuntimeValue } from "typesea";
import { createValidationError, type ValidationBoundary } from "./ValidationErrorMapping.js";
import { copyTypeSeaIssues } from "./ValidationResult.js";

/**
 * Validates an unknown value with TypeSea safe check semantics and maps failures to SABLI errors.
 *
 * @param guard - TypeSea guard to evaluate.
 * @param input - Unknown boundary input.
 * @param boundary - Boundary category used for error mapping.
 * @param summary - Stable English error summary.
 * @returns The validated value.
 * @throws SABLI domain errors instead of raw TypeSea diagnostics.
 */
export function assertValid<TValue, TPresence extends Presence>(
  guard: Guard<TValue, TPresence>,
  input: unknown,
  boundary: ValidationBoundary,
  summary: string
): RuntimeValue<TValue, TPresence> {
  const result = guard.check(input);
  if (!result.ok) {
    throw createValidationError(boundary, summary, copyTypeSeaIssues(result.error));
  }
  return result.value;
}

/**
 * Checks a value without allocating diagnostics and throws a stable SABLI error on failure.
 *
 * @param guard - TypeSea guard to evaluate.
 * @param input - Unknown boundary input.
 * @param boundary - Boundary category used for error mapping.
 * @param summary - Stable English error summary.
 * @returns The validated value.
 * @throws SABLI domain errors instead of raw TypeSea diagnostics.
 */
export function assertIs<TValue, TPresence extends Presence>(
  guard: Guard<TValue, TPresence>,
  input: unknown,
  boundary: ValidationBoundary,
  summary: string
): RuntimeValue<TValue, TPresence> {
  if (!guard.is(input)) {
    throw createValidationError(boundary, summary);
  }
  return input;
}
