import { normalizeJsonPath } from "../core/path.js";
import { SabliValidationError } from "../errors/index.js";
import type { Query, QueryExpression, QueryPredicate, QueryValue } from "../query/ast.js";
import { assertValid } from "./assertValid.js";
import { QueryInputGuard } from "./schemas.js";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueryValue(value: unknown): value is QueryValue {
  return value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function ownStringKeys(value: Readonly<Record<string, unknown>>, context: string): readonly string[] {
  const keys = Reflect.ownKeys(value);
  const strings: string[] = [];
  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new SabliValidationError(`Invalid query: ${context} must not include symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new SabliValidationError(`Invalid query: ${context} properties must be enumerable data properties.`);
    }
    strings.push(key);
  }
  return strings;
}

function getOwnValue(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
}

function hasOwnKey(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function assertOnlyKeys(input: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, context: string): readonly string[] {
  const keys = ownStringKeys(input, context);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new SabliValidationError(`Invalid query: unsupported ${context} field '${key}'.`);
    }
  }
  return keys;
}

function normalizeQueryPath(path: string): string {
  try {
    return normalizeJsonPath(path);
  } catch {
    throw new SabliValidationError("Invalid query: path syntax is invalid.");
  }
}

function parseExpressionArray(input: unknown, operator: "and" | "or"): readonly QueryExpression[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new SabliValidationError(`Invalid query: ${operator} requires a non-empty array.`);
  }
  const expressions: QueryExpression[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(input, index)) {
      throw new SabliValidationError(`Invalid query: ${operator} must not contain sparse array entries.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new SabliValidationError(`Invalid query: ${operator} entries must be data properties.`);
    }
    expressions.push(parseExpression(descriptor.value));
  }
  return expressions;
}

function parsePredicate(path: string, input: Readonly<Record<string, unknown>>): QueryPredicate {
  const normalizedPath = normalizeQueryPath(path);
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
  assertOnlyKeys(record, new Set(["path", "eq", "neq", "exists", "contains", "gt", "gte", "lt", "lte", "between"]), "predicate");

  const assignValue = (key: "eq" | "neq" | "contains"): void => {
    if (hasOwnKey(record, key)) {
      const value = getOwnValue(input, key);
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
    const exists = getOwnValue(input, "exists");
    if (typeof exists !== "boolean") {
      throw new SabliValidationError("Invalid query: exists requires a boolean value.");
    }
    predicate.exists = exists;
    operatorCount += 1;
  }
  for (const key of ["gt", "gte", "lt", "lte"] as const) {
    if (hasOwnKey(record, key)) {
      const value = getOwnValue(input, key);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SabliValidationError(`Invalid query: ${key} requires a finite number.`);
      }
      predicate[key] = value;
      operatorCount += 1;
    }
  }
  if (hasOwnKey(record, "between")) {
    const value = getOwnValue(input, "between");
    const left = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "0") : undefined;
    const right = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "1") : undefined;
    const leftValue: unknown = left !== undefined && "value" in left ? left.value : undefined;
    const rightValue: unknown = right !== undefined && "value" in right ? right.value : undefined;
    if (!Array.isArray(value) || value.length !== 2 || typeof leftValue !== "number" || typeof rightValue !== "number" || !Number.isFinite(leftValue) || !Number.isFinite(rightValue) || leftValue > rightValue) {
      throw new SabliValidationError("Invalid query: between requires an ordered numeric tuple.");
    }
    predicate.between = [leftValue, rightValue];
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
    assertOnlyKeys(record, new Set(["and"]), "expression");
    const and = getOwnValue(record, "and");
    return { and: parseExpressionArray(and, "and") };
  }
  if (hasOwnKey(record, "or")) {
    assertOnlyKeys(record, new Set(["or"]), "expression");
    const or = getOwnValue(record, "or");
    return { or: parseExpressionArray(or, "or") };
  }
  if (hasOwnKey(record, "not")) {
    assertOnlyKeys(record, new Set(["not"]), "expression");
    return { not: parseExpression(getOwnValue(record, "not")) };
  }
  if (hasOwnKey(record, "elemMatch")) {
    assertOnlyKeys(record, new Set(["elemMatch"]), "expression");
    const elemMatch = getOwnValue(record, "elemMatch");
    if (!isRecord(elemMatch)) {
      throw new SabliValidationError("Invalid query: elemMatch requires a path and where expression.");
    }
    assertOnlyKeys(elemMatch, new Set(["path", "where"]), "elemMatch");
    const elemMatchPath = getOwnValue(elemMatch, "path");
    return {
      elemMatch: {
        path: typeof elemMatchPath === "string" ? normalizeQueryPath(elemMatchPath) : (() => {
          throw new SabliValidationError("Invalid query: elemMatch requires a path and where expression.");
        })(),
        where: parseExpression(getOwnValue(elemMatch, "where"))
      }
    };
  }
  if (hasOwnKey(record, "path")) {
    const path = getOwnValue(record, "path");
    if (typeof path !== "string") {
      throw new SabliValidationError("Invalid query: predicate path must be a string.");
    }
    return parsePredicate(path, record);
  }

  const expressions = ownStringKeys(input, "where").map((path) => {
    const condition = getOwnValue(input, path);
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
  const object = assertValid(QueryInputGuard, input, "public", "Invalid query.");
  if (!hasOwnKey(object, "where")) {
    return { where: parseExpression(object) };
  }
  assertOnlyKeys(object, new Set(["where"]), "query");
  return { where: parseExpression(getOwnValue(object, "where")) };
}
