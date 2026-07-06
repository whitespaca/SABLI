import type { PostingList } from "../indexes/posting.js";

/**
 * Read-only posting cache diagnostics.
 */
export interface PostingCacheStats {
  /** Maximum number of cached posting lists. */
  readonly maxEntries: number;
  /** Current number of cached posting lists. */
  readonly size: number;
  /** Number of successful cache lookups. */
  readonly hits: number;
  /** Number of missed cache lookups. */
  readonly misses: number;
}

/**
 * Bounded least-recently-used cache for immutable segment posting lookups.
 */
export class PostingCache {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, PostingList>();
  #hits = 0;
  #misses = 0;

  /**
   * Creates a bounded posting cache.
   *
   * @param maxEntries - Maximum cache entries. Zero disables caching.
   */
  public constructor(maxEntries: number) {
    this.#maxEntries = Math.max(0, Math.floor(maxEntries));
  }

  /**
   * Maximum entries allowed in this cache.
   */
  public get maxEntries(): number {
    return this.#maxEntries;
  }

  /**
   * Current cache entry count.
   */
  public get size(): number {
    return this.#entries.size;
  }

  /**
   * Cache hit count.
   */
  public get hits(): number {
    return this.#hits;
  }

  /**
   * Cache miss count.
   */
  public get misses(): number {
    return this.#misses;
  }

  /**
   * Reads a posting list from the cache.
   *
   * @param key - Cache key including segment id and predicate identity.
   * @returns Cached posting list, or undefined.
   */
  public get(key: string): PostingList | undefined {
    if (this.#maxEntries === 0) {
      this.#misses += 1;
      return undefined;
    }
    const value = this.#entries.get(key);
    if (value === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /**
   * Stores a posting list in the cache.
   *
   * @param key - Cache key including segment id and predicate identity.
   * @param value - Posting list to cache.
   */
  public set(key: string, value: PostingList): void {
    if (this.#maxEntries === 0) {
      return;
    }
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }

  /**
   * Returns immutable cache diagnostics.
   *
   * @returns Cache statistics.
   */
  public stats(): PostingCacheStats {
    return {
      maxEntries: this.#maxEntries,
      size: this.#entries.size,
      hits: this.#hits,
      misses: this.#misses
    };
  }
}
