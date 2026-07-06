import type { DocId } from "../types/json.js";

/**
 * Default maximum size for the compact small-posting representation.
 */
export const DEFAULT_SMALL_POSTING_THRESHOLD = 16;

/**
 * Read-only posting list abstraction for candidate document identifiers.
 */
export interface PostingList {
  /** Number of document identifiers in the posting list. */
  readonly size: number;
  /**
   * Tests whether the posting list contains a document identifier.
   *
   * @param docId - Document identifier to test.
   * @returns True when present.
   */
  has(docId: DocId): boolean;
  /**
   * Returns the sorted document identifiers in this posting list.
   *
   * @returns Sorted document identifiers.
   */
  toArray(): readonly DocId[];
  /**
   * Intersects this posting list with another posting list.
   *
   * @param other - Posting list to intersect.
   * @returns A new posting list containing identifiers present in both lists.
   */
  intersect(other: PostingList): PostingList;
  /**
   * Unions this posting list with another posting list.
   *
   * @param other - Posting list to union.
   * @returns A new posting list containing identifiers present in either list.
   */
  union(other: PostingList): PostingList;
  /**
   * Removes another posting list from this posting list.
   *
   * @param other - Posting list to subtract.
   * @returns A new posting list containing identifiers not present in other.
   */
  difference(other: PostingList): PostingList;
}

/**
 * Options for adaptive posting list construction.
 */
export interface PostingListOptions {
  /** Maximum size that should use SmallPostingList. */
  readonly smallThreshold?: number;
}

function normalizeDocIds(docIds: Iterable<DocId>): readonly DocId[] {
  return Object.freeze([...new Set(docIds)].sort((left, right) => left - right));
}

function binarySearch(docIds: readonly DocId[], docId: DocId): boolean {
  let low = 0;
  let high = docIds.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = docIds[middle];
    if (value === undefined) {
      return false;
    }
    if (value === docId) {
      return true;
    }
    if (value < docId) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}

function mergeUnion(left: readonly DocId[], right: readonly DocId[]): readonly DocId[] {
  const out: DocId[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue !== undefined && (rightValue === undefined || leftValue < rightValue)) {
      out.push(leftValue);
      leftIndex += 1;
      continue;
    }
    if (rightValue !== undefined && (leftValue === undefined || rightValue < leftValue)) {
      out.push(rightValue);
      rightIndex += 1;
      continue;
    }
    if (leftValue !== undefined) {
      out.push(leftValue);
    }
    leftIndex += 1;
    rightIndex += 1;
  }
  return out;
}

function mergeIntersection(left: readonly DocId[], right: readonly DocId[]): readonly DocId[] {
  const out: DocId[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === undefined || rightValue === undefined) {
      break;
    }
    if (leftValue === rightValue) {
      out.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftValue < rightValue) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return out;
}

function mergeDifference(left: readonly DocId[], right: readonly DocId[]): readonly DocId[] {
  const out: DocId[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === undefined) {
      break;
    }
    if (rightValue === undefined || leftValue < rightValue) {
      out.push(leftValue);
      leftIndex += 1;
    } else if (leftValue === rightValue) {
      leftIndex += 1;
      rightIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return out;
}

abstract class BasePostingList implements PostingList {
  protected readonly docIds: readonly DocId[];

  protected constructor(docIds: Iterable<DocId>) {
    this.docIds = normalizeDocIds(docIds);
  }

  /** @inheritdoc */
  public get size(): number {
    return this.docIds.length;
  }

  /** @inheritdoc */
  public toArray(): readonly DocId[] {
    return this.docIds;
  }

  /** @inheritdoc */
  public intersect(other: PostingList): PostingList {
    return createPostingList(mergeIntersection(this.docIds, other.toArray()));
  }

  /** @inheritdoc */
  public union(other: PostingList): PostingList {
    return createPostingList(mergeUnion(this.docIds, other.toArray()));
  }

  /** @inheritdoc */
  public difference(other: PostingList): PostingList {
    return createPostingList(mergeDifference(this.docIds, other.toArray()));
  }

  /** @inheritdoc */
  public abstract has(docId: DocId): boolean;
}

/**
 * Compact posting list for very small sorted unique document-id sets.
 */
export class SmallPostingList extends BasePostingList {
  /**
   * Creates a small posting list.
   *
   * @param docIds - Candidate document identifiers.
   */
  public constructor(docIds: Iterable<DocId>) {
    super(docIds);
  }

  /** @inheritdoc */
  public has(docId: DocId): boolean {
    return this.docIds.includes(docId);
  }
}

/**
 * Sorted array backed posting list for medium and larger posting sets.
 */
export class SortedArrayPostingList extends BasePostingList {
  /**
   * Creates a sorted unique posting list.
   *
   * @param docIds - Candidate document identifiers.
   */
  public constructor(docIds: Iterable<DocId>) {
    super(docIds);
  }

  /** @inheritdoc */
  public has(docId: DocId): boolean {
    return binarySearch(this.docIds, docId);
  }
}

/**
 * Creates the default adaptive posting representation for a set of document identifiers.
 *
 * @param docIds - Candidate document identifiers.
 * @param options - Optional representation thresholds.
 * @returns A posting list using the smallest appropriate backend.
 */
export function createPostingList(docIds: Iterable<DocId>, options: PostingListOptions = {}): PostingList {
  const normalized = normalizeDocIds(docIds);
  const threshold = options.smallThreshold ?? DEFAULT_SMALL_POSTING_THRESHOLD;
  return normalized.length <= threshold
    ? new SmallPostingList(normalized)
    : new SortedArrayPostingList(normalized);
}
