import { describe, expect, it } from "vitest";
import { BloomFilter, SabliCorruptionError } from "../src/index.js";

describe("BloomFilter", () => {
  it("has no false negatives for inserted keys", () => {
    const filter = new BloomFilter({ expectedEntries: 10, falsePositiveRate: 0.01 });
    const keys = ["path:$.user.name", "term:$.tags[]:backend", "path:$.user.age"];
    for (const key of keys) {
      filter.add(key);
    }
    for (const key of keys) {
      expect(filter.mightContain(key)).toBe(true);
    }
  });

  it("round-trips through serialization", () => {
    const filter = new BloomFilter({ expectedEntries: 10, falsePositiveRate: 0.01 });
    filter.add("hello");
    const restored = BloomFilter.deserialize(filter.serialize());
    expect(restored.mightContain("hello")).toBe(true);
  });

  it("rejects malformed serialized filters", () => {
    expect(() => BloomFilter.deserialize({
      format: "sabli-bloom",
      version: 1,
      bitSize: 0,
      hashCount: 1,
      data: ""
    })).toThrow(SabliCorruptionError);
  });
});
