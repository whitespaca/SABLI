import { BloomFilter } from "../bloom/bloom-filter.js";
import { extractEntries } from "../extract/extractor.js";
import type { BloomOptions, QueryExpression, QueryPredicate } from "../query/ast.js";
import type { DocId, JsonObject, JsonPrimitive } from "../types/json.js";
import { createPostingList, type PostingList } from "../indexes/posting.js";

/**
 * Encodes a primitive value into the term key format used by SABLI postings.
 *
 * @param path - Canonical path.
 * @param value - Primitive JSON value.
 * @returns Stable term key.
 */
export function encodeTermKey(path: string, value: JsonPrimitive): string {
  return `${path}\u0000${value === null ? "null" : typeof value}\u0000${JSON.stringify(value)}`;
}

/**
 * Snapshot of all documents currently held in a memory segment.
 */
export interface MemSegmentSnapshot<TDocument extends JsonObject = JsonObject> {
  /** Documents paired with their assigned identifiers. */
  readonly documents: readonly { readonly docId: DocId; readonly document: TDocument }[];
  /** Last WAL sequence represented by the segment. */
  readonly lastWalSequence: number;
}

/**
 * Mutable in-memory write buffer used before data is flushed to immutable disk segments.
 */
export class MemSegment<TDocument extends JsonObject = JsonObject> {
  readonly #documents = new Map<DocId, TDocument>();
  readonly #deleted = new Set<DocId>();
  readonly #pathExists = new Map<string, Set<DocId>>();
  readonly #termPostings = new Map<string, Set<DocId>>();
  readonly #numericValues = new Map<string, Array<{ readonly docId: DocId; readonly value: number }>>();
  readonly #bloom: BloomFilter;
  #lastWalSequence = 0;

  /**
   * Creates an empty memory segment.
   *
   * @param bloomOptions - Bloom filter options.
   */
  public constructor(bloomOptions: BloomOptions) {
    this.#bloom = new BloomFilter(bloomOptions);
  }

  /**
   * Number of live documents in memory.
   */
  public get documentCount(): number {
    return [...this.#documents.keys()].filter((docId) => !this.#deleted.has(docId)).length;
  }

  /**
   * Number of physical document versions currently stored in memory.
   */
  public get physicalDocumentCount(): number {
    return this.#documents.size;
  }

  /**
   * Number of memory-resident document identifiers hidden by tombstones.
   */
  public get deletedDocumentCount(): number {
    return this.#deleted.size;
  }

  /**
   * Last WAL sequence represented by this segment.
   */
  public get lastWalSequence(): number {
    return this.#lastWalSequence;
  }

  /**
   * Inserts a validated document with a database-assigned document identifier.
   *
   * @param docId - Assigned document identifier.
   * @param document - Validated document.
   * @param walSequence - WAL sequence for recovery ordering.
   * @returns Number of extracted entries.
   */
  public insertWithDocId(docId: DocId, document: TDocument, walSequence: number): number {
    this.#documents.set(docId, document);
    this.#deleted.delete(docId);
    this.#lastWalSequence = Math.max(this.#lastWalSequence, walSequence);
    const entries = extractEntries(document);
    for (const entry of entries) {
      this.addPosting(this.#pathExists, entry.path, docId);
      this.#bloom.add(`path:${entry.path}`);
      const term = encodeTermKey(entry.path, entry.value);
      this.addPosting(this.#termPostings, term, docId);
      this.#bloom.add(`term:${term}`);
      if (typeof entry.value === "number") {
        const values = this.#numericValues.get(entry.path) ?? [];
        values.push({ docId, value: entry.value });
        this.#numericValues.set(entry.path, values);
      }
    }
    return entries.length;
  }

  /**
   * Reads a document by identifier.
   *
   * @param docId - Document identifier.
   * @returns Stored document, or undefined.
   */
  public getDocument(docId: DocId): TDocument | undefined {
    if (this.#deleted.has(docId)) {
      return undefined;
    }
    return this.#documents.get(docId);
  }

  /**
   * Marks a memory-resident document as deleted.
   *
   * @param docId - Document identifier to hide from future searches.
   * @param walSequence - WAL sequence for recovery ordering.
   */
  public delete(docId: DocId, walSequence: number): void {
    this.#deleted.add(docId);
    this.#lastWalSequence = Math.max(this.#lastWalSequence, walSequence);
  }

  /**
   * Tests whether the memory segment contains a physical document identifier.
   *
   * @param docId - Document identifier to test.
   * @returns True when the identifier is stored in memory.
   */
  public hasDocument(docId: DocId): boolean {
    return this.#documents.has(docId);
  }

  /**
   * Returns a snapshot suitable for segment flush.
   *
   * @returns Immutable view of memory segment contents.
   */
  public snapshot(): MemSegmentSnapshot<TDocument> {
    return {
      documents: [...this.#documents.entries()]
        .filter(([docId]) => !this.#deleted.has(docId))
        .map(([docId, document]) => ({ docId, document })),
      lastWalSequence: this.#lastWalSequence
    };
  }

  /**
   * Clears all in-memory contents.
   */
  public clear(): void {
    this.#documents.clear();
    this.#deleted.clear();
    this.#pathExists.clear();
    this.#termPostings.clear();
    this.#numericValues.clear();
    this.#lastWalSequence = 0;
  }

  /**
   * Generates candidate documents for a query expression.
   *
   * @param expression - Normalized query expression.
   * @returns Candidate document identifiers.
   */
  public candidates(expression: QueryExpression): PostingList {
    return this.candidatesForExpression(expression);
  }

  private allLiveDocuments(): PostingList {
    return createPostingList([...this.#documents.keys()].filter((docId) => !this.#deleted.has(docId)));
  }

  private addPosting(index: Map<string, Set<DocId>>, key: string, docId: DocId): void {
    const postings = index.get(key) ?? new Set<DocId>();
    postings.add(docId);
    index.set(key, postings);
  }

  private postingFromSet(values: ReadonlySet<DocId> | undefined): PostingList {
    return createPostingList(values === undefined ? [] : [...values].filter((docId) => !this.#deleted.has(docId)));
  }

  private candidatesForPredicate(predicate: QueryPredicate): PostingList {
    let candidates: PostingList | undefined;
    if (predicate.exists === true) {
      candidates = this.#bloom.mightContain(`path:${predicate.path}`)
        ? this.postingFromSet(this.#pathExists.get(predicate.path))
        : createPostingList([]);
    }
    const equalityValue = "eq" in predicate ? predicate.eq : "contains" in predicate ? predicate.contains : undefined;
    if (equalityValue !== undefined) {
      const term = encodeTermKey(predicate.path, equalityValue);
      const equality = this.#bloom.mightContain(`term:${term}`)
        ? this.postingFromSet(this.#termPostings.get(term))
        : createPostingList([]);
      candidates = candidates === undefined ? equality : candidates.intersect(equality);
    }
    const numeric = this.numericCandidates(predicate);
    if (numeric !== undefined) {
      candidates = candidates === undefined ? numeric : candidates.intersect(numeric);
    }
    return candidates ?? this.allLiveDocuments();
  }

  private numericCandidates(predicate: QueryPredicate): PostingList | undefined {
    const hasNumeric =
      predicate.gt !== undefined ||
      predicate.gte !== undefined ||
      predicate.lt !== undefined ||
      predicate.lte !== undefined ||
      predicate.between !== undefined;
    if (!hasNumeric) {
      return undefined;
    }
    return createPostingList(
      (this.#numericValues.get(predicate.path) ?? [])
        .filter(({ value }) => {
          if (predicate.gt !== undefined && value <= predicate.gt) {
            return false;
          }
          if (predicate.gte !== undefined && value < predicate.gte) {
            return false;
          }
          if (predicate.lt !== undefined && value >= predicate.lt) {
            return false;
          }
          if (predicate.lte !== undefined && value > predicate.lte) {
            return false;
          }
          if (predicate.between !== undefined) {
            const [min, max] = predicate.between;
            return value >= min && value <= max;
          }
          return true;
        })
        .map(({ docId }) => docId)
    );
  }

  private candidatesForExpression(expression: QueryExpression): PostingList {
    if ("and" in expression) {
      const candidates = expression.and
        .map((child) => this.candidatesForExpression(child))
        .sort((left, right) => left.size - right.size);
      const [first, ...rest] = candidates;
      if (first === undefined || first.size === 0) {
        return createPostingList([]);
      }
      let acc = first;
      for (const child of rest) {
        acc = acc.intersect(child);
        if (acc.size === 0) {
          return acc;
        }
      }
      return acc;
    }
    if ("or" in expression) {
      let acc: PostingList = createPostingList([]);
      for (const child of expression.or) {
        acc = acc.union(this.candidatesForExpression(child));
      }
      return acc;
    }
    if ("not" in expression) {
      return this.allLiveDocuments().difference(this.candidatesForExpression(expression.not));
    }
    if ("elemMatch" in expression) {
      // TODO: Add scope-aware candidate planning once scoped array postings are implemented.
      return this.candidatesForExpression(expression.elemMatch.where);
    }
    return this.candidatesForPredicate(expression);
  }
}
