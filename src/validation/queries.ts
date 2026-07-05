import { normalizeJsonPath } from "../core/path.js";
import { SabliValidationError } from "../errors/index.js";
import type { Query, QueryExpression, QueryPredicate, QueryValue } from "../query/ast.js";
import { formatValidationError } from "./errors.js";
import { QueryInputGuard, type QueryExpressionInput, type QueryPredicateOperatorsInput } from "./schemas.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parsePredicate(path: string, input: QueryPredicateOperatorsInput): QueryPredicate {
  const normalizedPath = normalizeJsonPath(path);
  const predicate: {
    path: string;
    eq?: QueryValue;
    neq?: QueryValue;
    exists?: boolean;
    contains?: QueryValue;
    gt?: number;
    gte?: number;
    lt?: number;
    lte?: number;
    between?: readonly [number, number];
  } = { path: normalizedPath };
  let operatorCount = 0;
  const record = input as Readonly<Record<string, unknown>>;

  const assignValue = (key: "eq" | "neq" | "contains"): void => {
    if (hasOwnKey(record, key)) {
      const value = input[key];
      if (value === undefined) {
        throw new SabliValidationError(`Invalid query: ${key} requires a primitive JSON value.`);
      }
      predicate[key] = value;
      operatorCount += 1;
    }
  };
  assignValue("eq");
  assignValue("neq");
  assignValue("contains");

  if (hasOwnKey(record, "exists")) {
    if (input.exists === undefined) {
      throw new SabliValidationError("Invalid query: exists requires a boolean value.");
    }
    predicate.exists = input.exists;
    operatorCount += 1;
  }
  for (const key of ["gt", "gte", "lt", "lte"] as const) {
    if (hasOwnKey(record, key)) {
      const value = input[key];
      if (value === undefined) {
        throw new SabliValidationError(`Invalid query: ${key} requires a finite number.`);
      }
      predicate[key] = value;
      operatorCount += 1;
    }
  }
  if (hasOwnKey(record, "between")) {
    const value = input.between;
    if (value === undefined || value[0] > value[1]) {
      throw new SabliValidationError("Invalid query: between requires an ordered numeric tuple.");
    }
    predicate.between = value;
    operatorCount += 1;
  }
  if (operatorCount === 0) {
    throw new SabliValidationError("Invalid query: predicate must include at least one operator.");
  }
  return predicate;
}

function parseExpression(input: QueryExpressionInput): QueryExpression {
  if (!isRecord(input)) {
    throw new SabliValidationError("Invalid query: where must be an object.");
  }
  const record = input as Readonly<Record<string, unknown>>;
  if (hasOwnKey(record, "and")) {
    const and = record.and;
    if (!Array.isArray(and) || and.length === 0) {
      throw new SabliValidationError("Invalid query: and requires a non-empty array.");
    }
    return { and: and.map((expression: unknown) => parseExpression(expression as QueryExpressionInput)) };
  }
  if (hasOwnKey(record, "or")) {
    const or = record.or;
    if (!Array.isArray(or) || or.length === 0) {
      throw new SabliValidationError("Invalid query: or requires a non-empty array.");
    }
    return { or: or.map((expression: unknown) => parseExpression(expression as QueryExpressionInput)) };
  }
  if (hasOwnKey(record, "not")) {
    return { not: parseExpression(record.not as QueryExpressionInput) };
  }
  if (hasOwnKey(record, "elemMatch")) {
    const elemMatch = record.elemMatch;
    if (!isRecord(elemMatch) || typeof elemMatch.path !== "string") {
      throw new SabliValidationError("Invalid query: elemMatch requires a path and where expression.");
    }
    return {
      elemMatch: {
        path: normalizeJsonPath(elemMatch.path),
        where: parseExpression(elemMatch.where as QueryExpressionInput)
      }
    };
  }
  if (hasOwnKey(record, "path")) {
    if (typeof record.path !== "string") {
      throw new SabliValidationError("Invalid query: predicate path must be a string.");
    }
    return parsePredicate(record.path, input as QueryPredicateOperatorsInput);
  }

  const expressions = Object.entries(input).map(([path, condition]) => {
    if (!isRecord(condition)) {
      throw new SabliValidationError("Invalid query: field conditions must be objects.");
    }
    return parsePredicate(path, condition);
  });
  if (expressions.length === 0) {
    throw new SabliValidationError("Invalid query: where must not be empty.");
  }
  return expressions.length === 1 ? expressions[0] as QueryExpression : { and: expressions };
}

/**
 * Validates and narrows an unknown value into a SABLI query.
 *
 * @param input - The unknown query supplied by the caller.
 * @returns The validated query.
 * @throws {SabliValidationError} If the query shape is invalid.
 */
export function parseQuery(input: unknown): Query {
  const result = QueryInputGuard.check(input);
  if (!result.ok) {
    throw new SabliValidationError(formatValidationError("Invalid query.", result.error));
  }
  const object = result.value as Readonly<Record<string, unknown>>;
  if (!hasOwnKey(object, "where")) {
    return { where: parseExpression(result.value as QueryExpressionInput) };
  }
  return { where: parseExpression(object.where as QueryExpressionInput) };
}
