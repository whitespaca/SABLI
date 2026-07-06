import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseJsonDocument,
  parseQuery,
  parseDatabaseManifest,
  parseDatabaseOptions,
  parseSabliOptions,
  parseSegmentManifest,
  SabliCorruptionError,
  SabliRecoveryError,
  SabliValidationError
} from "../src/index.js";
import { checksum, stableJson } from "../src/storage/Checksum.js";
import { parseWalRecord } from "../src/storage/WalStore.js";
import { parseSegmentMetadata } from "../src/validation/SegmentMetadataValidation.js";
import { BloomFilter } from "../src/bloom/bloom-filter.js";

describe("TypeSea validation boundaries", () => {
  it("accepts valid JSON documents", () => {
    expect(parseJsonDocument({ user: { name: "Kim" }, tags: ["backend"] })).toEqual({
      user: { name: "Kim" },
      tags: ["backend"]
    });
  });

  it("rejects unsupported document values", () => {
    expect(() => parseJsonDocument({ createdAt: new Date() })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: undefined })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: Number.NaN })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: Infinity })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: -Infinity })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: () => undefined })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: Symbol("bad") })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument({ value: 1n })).toThrow(SabliValidationError);
    expect(() => parseJsonDocument(null)).toThrow(SabliValidationError);
    expect(() => parseJsonDocument(["not-root-object"])).toThrow(SabliValidationError);
  });

  it("rejects hostile document shapes without executing getters", () => {
    const withThrowingGetter: Record<string, unknown> = {};
    let getterExecuted = false;
    Object.defineProperty(withThrowingGetter, "bad", {
      enumerable: true,
      get() {
        getterExecuted = true;
        throw new Error("getter executed");
      }
    });
    expect(() => parseJsonDocument(withThrowingGetter)).toThrow(SabliValidationError);
    expect(getterExecuted).toBe(false);

    const withSymbolKey: Record<PropertyKey, unknown> = { ok: true };
    withSymbolKey[Symbol("hidden")] = true;
    expect(() => parseJsonDocument(withSymbolKey)).toThrow(SabliValidationError);

    const withNonEnumerable = { ok: true };
    Object.defineProperty(withNonEnumerable, "hidden", { value: true, enumerable: false });
    expect(() => parseJsonDocument(withNonEnumerable)).toThrow(SabliValidationError);

    const sparseDocumentArray = Array<number>(3);
    sparseDocumentArray[0] = 1;
    sparseDocumentArray[2] = 3;
    expect(() => parseJsonDocument({ list: sparseDocumentArray })).toThrow(SabliValidationError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseJsonDocument(cyclic)).toThrow(SabliValidationError);
  });

  it("treats prototype-pollution-looking document keys as ordinary data", () => {
    const parsed = parseJsonDocument(JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}')) as Record<string, unknown>;
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects invalid queries with SABLI-specific errors", () => {
    expect(() => parseQuery({ where: { and: [] } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { "user.name": { eq: { nested: true } } } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { "user.name": { eq: "Kim", unknown: true } } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { path: "user.name", eq: "Kim", bogus: true } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { path: "", eq: "Kim" } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { path: "tags[]", contains: undefined } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { path: "tags[]", exists: "yes" } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { and: [{ path: "user.name", eq: "Kim" }, { path: "bad..path", eq: "Kim" }] } })).toThrow(SabliValidationError);
    expect(() => parseQuery({ where: { elemMatch: { path: "items[]", where: { path: "x", eq: 1 }, extra: true } } })).toThrow(SabliValidationError);
  });

  it("rejects hostile query shapes without executing getters", () => {
    const query: Record<string, unknown> = { where: {} };
    let getterExecuted = false;
    Object.defineProperty(query.where as Record<string, unknown>, "path", {
      enumerable: true,
      get() {
        getterExecuted = true;
        throw new Error("getter executed");
      }
    });
    expect(() => parseQuery(query)).toThrow(SabliValidationError);
    expect(getterExecuted).toBe(false);

    const withSymbol: Record<PropertyKey, unknown> = { where: { path: "x", eq: 1 } };
    withSymbol[Symbol("extra")] = true;
    expect(() => parseQuery(withSymbol)).toThrow(SabliValidationError);

    const withNonEnumerable = { where: { path: "x", eq: 1 } };
    Object.defineProperty(withNonEnumerable, "hidden", { value: true, enumerable: false });
    expect(() => parseQuery(withNonEnumerable)).toThrow(SabliValidationError);

    const sparseQueryArray = Array<unknown>(3);
    sparseQueryArray[0] = { path: "x", eq: 1 };
    sparseQueryArray[2] = { path: "y", eq: 2 };
    expect(() => parseQuery({ where: { and: sparseQueryArray } })).toThrow(SabliValidationError);
  });

  it("applies option defaults and rejects malformed options", () => {
    expect(parseSabliOptions(undefined).bloom.falsePositiveRate).toBe(0.01);
    expect(() => parseSabliOptions({ bloom: { falsePositiveRate: 2 } })).toThrow(SabliValidationError);
    expect(() => parseSabliOptions({ mutableSegmentMaxDocuments: 10, extra: true })).toThrow(SabliValidationError);
    const optionsWithHidden = { path: "./data.sabli" };
    Object.defineProperty(optionsWithHidden, "hidden", { value: true, enumerable: false });
    expect(() => parseDatabaseOptions(optionsWithHidden)).toThrow(SabliValidationError);
  });

  it("wraps malformed persisted metadata as corruption errors", () => {
    expect(() => parseSegmentManifest({ format: "bad", version: 1 })).toThrow(SabliCorruptionError);
    expect(parseSegmentManifest({
      format: "sabli-segment",
      version: 1,
      segmentId: 1,
      docCount: 2,
      createdAt: "2026-07-05T00:00:00.000Z"
    }).docCount).toBe(2);
  });

  it("rejects malformed database manifests before checksum trust", () => {
    const payload = {
      format: "sabli-manifest" as const,
      version: 1 as const,
      nextDocId: 1,
      nextSegmentId: 1,
      segments: [{ segmentId: 1, path: "", docCount: 0 }],
      flushedWalSequence: 0,
      activeWalGeneration: 1
    };
    expect(() => parseDatabaseManifest({
      ...payload,
      checksum: checksum(stableJson(payload))
    })).toThrow(SabliCorruptionError);
  });

  it("rejects malformed WAL records through the compiled guard", () => {
    expect(() => parseWalRecord({
      format: "sabli-wal-record",
      version: 1,
      sequence: 0,
      type: "delete",
      docId: 1
    })).toThrow(SabliRecoveryError);
    expect(() => parseWalRecord({
      format: "sabli-wal-record",
      version: 1,
      sequence: 1,
      type: "insert",
      docId: 1,
      document: { bad: undefined }
    })).toThrow(SabliRecoveryError);
    expect(() => parseWalRecord({
      format: "sabli-wal-record",
      version: 1,
      sequence: 1,
      type: "insert",
      docId: 1,
      document: { ok: true },
      extra: true
    })).toThrow(SabliRecoveryError);
    expect(() => parseWalRecord({
      format: "sabli-wal-record",
      version: 1,
      sequence: 1,
      type: "unknown",
      docId: 1
    })).toThrow(SabliRecoveryError);
  });

  it("rejects strict manifest and segment metadata extras", () => {
    const manifestPayload = {
      format: "sabli-manifest" as const,
      version: 1 as const,
      nextDocId: 2,
      nextSegmentId: 1,
      segments: [],
      flushedWalSequence: 0,
      activeWalGeneration: 1
    };
    expect(() => parseDatabaseManifest({
      ...manifestPayload,
      checksum: checksum(stableJson(manifestPayload)),
      extra: true
    })).toThrow(SabliCorruptionError);

    const segmentPayload = {
      format: "sabli-segment" as const,
      version: 1 as const,
      segmentId: 1,
      docCount: 1,
      minDocId: 1,
      maxDocId: 1,
      createdAt: "2026-07-05T00:00:00.000Z",
      bloom: new BloomFilter({ expectedEntries: 10, falsePositiveRate: 0.01 }).serialize()
    };
    expect(() => parseSegmentMetadata({
      ...segmentPayload,
      checksum: checksum(stableJson(segmentPayload)),
      extra: true
    })).toThrow(SabliCorruptionError);
  });

  it("does not expose raw TypeSea errors from public validation", () => {
    try {
      parseJsonDocument({ bad: undefined });
      throw new Error("expected parseJsonDocument to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SabliValidationError);
      expect((error as Error).name).toBe("SabliValidationError");
      expect((error as Error).name).not.toContain("TypeSea");
    }
  });

  it("does not use unsafe or unchecked TypeSea validation modes", async () => {
    const files = [
      "src/validation/schemas.ts",
      "src/validation/DatabaseOptionsValidation.ts",
      "src/validation/SegmentMetadataValidation.ts"
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toContain('mode: "unsafe"');
    expect(source).not.toContain('mode: "unchecked"');
  });
});
