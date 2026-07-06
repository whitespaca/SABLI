import { describe, expect, it } from "vitest";
import { createPostingList, SmallPostingList, SortedArrayPostingList, toDocId, type PostingList } from "../src/index.js";

function values(posting: PostingList): readonly number[] {
  return posting.toArray();
}

describe("posting lists", () => {
  it("normalizes document identifiers into sorted unique order", () => {
    expect(values(new SmallPostingList([toDocId(3), toDocId(1), toDocId(3), toDocId(2)]))).toEqual([1, 2, 3]);
    expect(values(new SortedArrayPostingList([toDocId(9), toDocId(4), toDocId(4), toDocId(7)]))).toEqual([4, 7, 9]);
  });

  it("supports empty and singleton postings", () => {
    const empty = createPostingList([]);
    const one = createPostingList([toDocId(1)]);
    expect(empty.size).toBe(0);
    expect(one.size).toBe(1);
    expect(one.has(toDocId(1))).toBe(true);
    expect(one.has(toDocId(2))).toBe(false);
    expect(values(empty.union(one))).toEqual([1]);
    expect(values(one.intersect(empty))).toEqual([]);
  });

  it("performs intersection union and difference", () => {
    const left = createPostingList([toDocId(1), toDocId(2), toDocId(4), toDocId(8)]);
    const right = createPostingList([toDocId(2), toDocId(3), toDocId(4), toDocId(9)]);
    expect(values(left.intersect(right))).toEqual([2, 4]);
    expect(values(left.union(right))).toEqual([1, 2, 3, 4, 8, 9]);
    expect(values(left.difference(right))).toEqual([1, 8]);
  });

  it("selects small and sorted representations adaptively", () => {
    expect(createPostingList([toDocId(1), toDocId(2)])).toBeInstanceOf(SmallPostingList);
    expect(createPostingList(Array.from({ length: 20 }, (_, index) => toDocId(index + 1)))).toBeInstanceOf(SortedArrayPostingList);
    expect(createPostingList([toDocId(1), toDocId(2)], { smallThreshold: 1 })).toBeInstanceOf(SortedArrayPostingList);
  });

  it("keeps small and sorted implementations result-equivalent", () => {
    const leftSmall = new SmallPostingList([toDocId(1), toDocId(3), toDocId(5)]);
    const leftSorted = new SortedArrayPostingList([toDocId(1), toDocId(3), toDocId(5)]);
    const rightSmall = new SmallPostingList([toDocId(3), toDocId(4), toDocId(5)]);
    const rightSorted = new SortedArrayPostingList([toDocId(3), toDocId(4), toDocId(5)]);
    expect(values(leftSmall.intersect(rightSmall))).toEqual(values(leftSorted.intersect(rightSorted)));
    expect(values(leftSmall.union(rightSmall))).toEqual(values(leftSorted.union(rightSorted)));
    expect(values(leftSmall.difference(rightSmall))).toEqual(values(leftSorted.difference(rightSorted)));
  });

  it("handles large postings with binary-search membership", () => {
    const posting = createPostingList(Array.from({ length: 500 }, (_, index) => toDocId(index * 2 + 2)));
    expect(posting).toBeInstanceOf(SortedArrayPostingList);
    expect(posting.has(toDocId(400))).toBe(true);
    expect(posting.has(toDocId(401))).toBe(false);
  });
});
