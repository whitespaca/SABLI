import { SabliValidationError } from "../errors/index.js";
import type { JsonObject, JsonValue } from "../types/json.js";
import { assertValid } from "./assertValid.js";
import { JsonObjectGuard } from "./schemas.js";

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSupportedJsonValue(value: unknown, path: string, seen: WeakSet<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SabliValidationError(`Unsupported JSON value at ${path}: numbers must be finite.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new SabliValidationError(`Unsupported JSON value at ${path}: cyclic values are not supported.`);
    }
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new SabliValidationError(`Unsupported JSON value at ${path}[${String(index)}]: sparse arrays are not supported.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new SabliValidationError(`Unsupported JSON value at ${path}[${String(index)}]: accessor array entries are not supported.`);
      }
      assertSupportedJsonValue(descriptor.value, `${path}[${String(index)}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (isPlainJsonObject(value)) {
    if (seen.has(value)) {
      throw new SabliValidationError(`Unsupported JSON value at ${path}: cyclic values are not supported.`);
    }
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new SabliValidationError(`Unsupported JSON value at ${path}: symbol keys are not supported.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new SabliValidationError(`Unsupported JSON value at ${path}.${key}: JSON object properties must be enumerable data properties.`);
      }
      assertSupportedJsonValue(descriptor.value, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  const label = Object.prototype.toString.call(value).slice(8, -1);
  throw new SabliValidationError(`Unsupported JSON value at ${path}: ${label} values must be serialized before indexing.`);
}

/**
 * Validates and narrows an unknown value into a JSON object accepted by SABLI.
 *
 * @param input - The unknown value supplied by the caller.
 * @returns The validated JSON object.
 * @throws {SabliValidationError} If the value is not a supported JSON object.
 */
export function parseJsonDocument(input: unknown): JsonObject {
  const document = assertValid(JsonObjectGuard, input, "public", "Invalid JSON document.");
  if (!isPlainJsonObject(input)) {
    throw new SabliValidationError("Invalid JSON document: the root value must be a plain JSON object.");
  }
  assertSupportedJsonValue(input, "$", new WeakSet());
  return document;
}
