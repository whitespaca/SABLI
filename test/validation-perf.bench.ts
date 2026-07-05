import { bench, describe } from "vitest";
import { t, compile } from "typesea";

const DatabaseOptionsInputGuard = t.record(t.unknown);

function parseManual(input: unknown) {
  const result = DatabaseOptionsInputGuard.check(input);
  if (!result.ok || typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid");
  }
  const record = input as Readonly<Record<string, unknown>>;
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw new Error("Invalid");
  }
  const createIfMissing = record.createIfMissing === undefined ? false : record.createIfMissing;
  if (typeof createIfMissing !== "boolean") {
    throw new Error("Invalid");
  }
  const memSegmentMaxDocuments = record.memSegmentMaxDocuments === undefined ? 1_000 : record.memSegmentMaxDocuments;
  if (typeof memSegmentMaxDocuments !== "number" || !Number.isInteger(memSegmentMaxDocuments) || memSegmentMaxDocuments < 1) {
    throw new Error("Invalid");
  }
  const durability = record.durability === undefined ? "strict" : record.durability;
  if (durability !== "strict" && durability !== "relaxed") {
    throw new Error("Invalid");
  }
  return { path: record.path, createIfMissing, memSegmentMaxDocuments, durability };
}

const DatabaseOptionsGuard = compile(t.object({
  path: t.string.min(1),
  createIfMissing: t.boolean.optional(),
  memSegmentMaxDocuments: t.number.int().gte(1).optional(),
  durability: t.union(t.literal("strict"), t.literal("relaxed")).optional()
}));

function parseCompiled(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid");
  const result = DatabaseOptionsGuard.check(input);
  if (!result.ok) throw new Error("Invalid");
  const record = result.value;
  return {
    path: record.path,
    createIfMissing: record.createIfMissing ?? false,
    memSegmentMaxDocuments: record.memSegmentMaxDocuments ?? 1000,
    durability: record.durability ?? "strict"
  };
}

const validPayload = { path: "/data/db", createIfMissing: true, memSegmentMaxDocuments: 5000, durability: "relaxed" };
const invalidPayload = { path: "/data/db", memSegmentMaxDocuments: "not-a-number" };

describe("Validation Performance", () => {
  bench("Manual (Valid)", () => {
    parseManual(validPayload);
  });
  bench("TypeSea Compiled (Valid)", () => {
    parseCompiled(validPayload);
  });
  bench("Manual (Invalid)", () => {
    try {
      parseManual(invalidPayload);
    } catch {
      return;
    }
  });
  bench("TypeSea Compiled (Invalid)", () => {
    try {
      parseCompiled(invalidPayload);
    } catch {
      return;
    }
  });
});
