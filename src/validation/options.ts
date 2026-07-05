import { SabliValidationError } from "../errors/index.js";
import type { SabliOptions } from "../query/ast.js";
import { formatValidationError } from "./errors.js";
import { OptionsInputGuard } from "./schemas.js";

/**
 * Default SABLI options used when the caller omits constructor options.
 */
export const DEFAULT_SABLI_OPTIONS: SabliOptions = {
  mutableSegmentMaxDocuments: 100_000,
  bloom: {
    falsePositiveRate: 0.01,
    expectedEntries: 10_000
  }
};

/**
 * Validates and narrows unknown constructor options.
 *
 * @param input - The unknown options supplied by the caller.
 * @returns Validated SABLI options with defaults applied.
 * @throws {SabliValidationError} If the options are invalid.
 */
export function parseSabliOptions(input: unknown): SabliOptions {
  const result = OptionsInputGuard.check(input);
  if (!result.ok) {
    throw new SabliValidationError(formatValidationError("Invalid options.", result.error));
  }
  const options = result.value ?? {};
  const bloom = options.bloom ?? {};
  return {
    mutableSegmentMaxDocuments: options.mutableSegmentMaxDocuments ?? DEFAULT_SABLI_OPTIONS.mutableSegmentMaxDocuments,
    bloom: {
      falsePositiveRate: bloom.falsePositiveRate ?? DEFAULT_SABLI_OPTIONS.bloom.falsePositiveRate,
      expectedEntries: bloom.expectedEntries ?? DEFAULT_SABLI_OPTIONS.bloom.expectedEntries
    }
  };
}
