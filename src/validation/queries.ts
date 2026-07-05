import { normalizeJsonPath } from "../core/path.js";
import { SabliValidationError } from "../errors/index.js";
import type { Query, QueryExpression, QueryPredicate, QueryValue } from "../query/ast.js";
import { formatValidationError } from "./errors.js";
import { QueryInputGuard } from "./schemas.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryValue(value: unknown): value is QueryValue {
  return value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function hasOwnKey(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parsePredicate(path: string, input: Readonly<Record<string, unknown>>): QueryPredicate {
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
  const record = input;

  const assignValue = (key: "eq" | "neq" | "contains"): void => {
    if (hasOwnKey(record, key)) {
      const value = input[key];
      if (!isQueryValue(value)) {
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
    if (typeof input.exists !== "boolean") {
      throw new SabliValidationError("Invalid query: exists requires a boolean value.");
    }
    predicate.exists = input.exists;
    operatorCount += 1;
  }
  for (const key of ["gt", "gte", "lt", "lte"] as const) {
    if (hasOwnKey(record, key)) {
      const value = input[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SabliValidationError(`Invalid query: ${key} requires a finite number.`);
      }
      predicate[key] = value;
      operatorCount += 1;
    }
  }
  if (hasOwnKey(record, "between")) {
    const value = input.between;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number" || value[0] > value[1]) {
      throw new SabliValidationError("Invalid query: between requires an ordered numeric tuple.");
    }
    predicate.between = [value[0], value[1]];
    operatorCount += 1;
  }
  if (operatorCount === 0) {
    throw new SabliValidationError("Invalid query: predicate must include at least one operator.");
  }
  return predicate;
}

function parseExpression(input: unknown): QueryExpression {
  if (!isRecord(input)) {
    throw new SabliValidationError("Invalid query: where must be an object.");
  }
  const record = input;
  if (hasOwnKey(record, "and")) {
    const and = record.and;
    if (!Array.isArray(and) || and.length === 0) {
      throw new SabliValidationError("Invalid query: and requires a non-empty array.");
    }
    return { and: and.map(parseExpression) };
  }
  if (hasOwnKey(record, "or")) {
    const or = record.or;
    if (!Array.isArray(or) || or.length === 0) {
      throw new SabliValidationError("Invalid query: or requires a non-empty array.");
    }
    return { or: or.map(parseExpression) };
  }
  if (hasOwnKey(record, "not")) {
    return { not: parseExpression(record.not) };
  }
  if (hasOwnKey(record, "elemMatch")) {
    const elemMatch = record.elemMatch;
    if (!isRecord(elemMatch) || typeof elemMatch.path !== "string") {
      throw new SabliValidationError("Invalid query: elemMatch requires a path and where expression.");
    }
    return {
      elemMatch: {
        path: normalizeJsonPath(elemMatch.path),
        where: parseExpression(elemMatch.where)
      }
    };
  }
  if (hasOwnKey(record, "path")) {
    if (typeof record.path !== "string") {
      throw new SabliValidationError("Invalid query: predicate path must be a string.");
    }
    return parsePredicate(record.path, record);
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
  const object = input as Readonly<Record<string, unknown>>;
  if (!hasOwnKey(object, "where")) {
    return { where: parseExpression(object) };
  }
  return { where: parseExpression(object.where) };
}
