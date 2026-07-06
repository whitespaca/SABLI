import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BloomFilter } from "../bloom/bloom-filter.js";
import { DocumentBlockReader } from "../storage/DocumentBlockStore.js";
import { writeFileAtomic } from "../storage/AtomicFile.js";
import type { DocId, JsonObject } from "../types/json.js";
import { toDocId } from "../types/json.js";
import { parseSegmentMetadata } from "../validation/SegmentMetadataValidation.js";
import { createPostingList, type PostingList } from "../indexes/posting.js";
import type { QueryExpression, QueryPredicate } from "../query/ast.js";
import { encodeTermKey } from "./MemSegment.js";
import type { SegmentMetadata } from "./SegmentMetadata.js";
import { PostingCache, type PostingCacheStats } from "./PostingCache.js";
import {
  DeleteBitmapFileGuard,
  OffsetTableFileGuard,
  PostingIndexFileGuard,
  type PostingIndexFileInput
} from "../validation/schemas.js";
import { assertValid } from "../validation/assertValid.js";

type PostingIndexFile = PostingIndexFileInput;

/**
 * Derived posting statistics for one immutable segment.
 */
export interface ImmutableSegmentPostingStats {
  /** Number of unique path-exists posting keys. */
  readonly pathKeyCount: number;
  /** Total path-exists posting rows. */
  readonly pathPostingCount: number;
  /** Number of unique equality or contains term posting keys. */
  readonly termKeyCount: number;
  /** Total equality or contains posting rows. */
  readonly termPostingCount: number;
}

interface DeleteBitmapFile {
  readonly format: "sabli-delete-bitmap";
  readonly version: 1;
  readonly deleted: readonly number[];
}

/**
 * Immutable disk-backed segment reader.
 */
export class ImmutableSegment {
  readonly #root: string;
  readonly #metadata: SegmentMetadata;
  readonly #bloom: BloomFilter;
  readonly #postingCache: PostingCache;
  readonly #deleted = new Set<number>();
  #postings: PostingIndexFile | undefined;
  #documents: DocumentBlockReader | undefined;

  private constructor(root: string, metadata: SegmentMetadata, postingCacheMaxEntries: number) {
    this.#root = root;
    this.#metadata = metadata;
    this.#bloom = BloomFilter.deserialize(metadata.bloom);
    this.#postingCache = new PostingCache(postingCacheMaxEntries);
  }

  /**
   * Opens an immutable segment from disk.
   *
   * @param root - Segment directory path.
   * @returns Open segment reader.
   */
  public static async open(root: string, options: { readonly postingCacheMaxEntries?: number } = {}): Promise<ImmutableSegment> {
    const metadata = parseSegmentMetadata(JSON.parse(await readFile(join(root, "segment.meta.json"), "utf8")));
    const segment = new ImmutableSegment(root, metadata, options.postingCacheMaxEntries ?? 128);
    await segment.loadDeleteBitmap();
    return segment;
  }

  /**
   * Segment metadata.
   */
  public get metadata(): SegmentMetadata {
    return this.#metadata;
  }

  /**
   * Number of physical document versions written to this segment.
   */
  public get documentCount(): number {
    return this.#metadata.docCount;
  }

  /**
   * Number of document identifiers hidden by this segment delete bitmap.
   */
  public get deletedDocumentCount(): number {
    return this.#deleted.size;
  }

  /**
   * Approximate number of visible documents in this segment.
   */
  public get liveDocumentCount(): number {
    return Math.max(0, this.#metadata.docCount - this.#deleted.size);
  }

  /**
   * Posting cache diagnostics for this segment.
   */
  public get postingCacheStats(): PostingCacheStats {
    return this.#postingCache.stats();
  }

  /**
   * Returns derived posting statistics from the validated posting index.
   *
   * @returns Posting statistics.
   */
  public async postingStats(): Promise<ImmutableSegmentPostingStats> {
    const postings = await this.postings();
    return {
      pathKeyCount: postings.pathExists.length,
      pathPostingCount: postings.pathExists.reduce((sum, row) => sum + row[1].length, 0),
      termKeyCount: postings.termPostings.length,
      termPostingCount: postings.termPostings.reduce((sum, row) => sum + row[1].length, 0)
    };
  }

  /**
   * Generates candidate documents for a query expression.
   *
   * @param expression - Normalized query expression.
   * @returns Candidate document identifiers.
   */
  public async candidates(expression: QueryExpression): Promise<PostingList> {
    return this.candidatesForExpression(expression);
  }

  /**
   * Reads one raw document by identifier.
   *
   * @param docId - Document identifier.
   * @returns Raw document or undefined.
   */
  public async getDocument(docId: DocId): Promise<JsonObject | undefined> {
    if (this.isDeleted(docId)) {
      return undefined;
    }
    const reader = await this.documentReader();
    return reader.read(docId);
  }

  /**
   * Reads all currently visible documents from this immutable segment.
   *
   * @returns Visible documents paired with their document identifiers.
   */
  public async readLiveDocuments(): Promise<readonly { readonly docId: DocId; readonly document: JsonObject }[]> {
    const reader = await this.documentReader();
    const documents = await reader.readAll();
    return documents.filter(({ docId }) => !this.isDeleted(docId));
  }

  /**
   * Marks a document identifier deleted in this immutable segment.
   *
   * @param docId - Document identifier to tombstone.
   */
  public async markDeleted(docId: DocId): Promise<void> {
    if (Number(docId) < this.#metadata.minDocId || Number(docId) > this.#metadata.maxDocId) {
      return;
    }
    const document = await this.getDocumentIgnoringDelete(docId);
    if (document === undefined) {
      return;
    }
    this.#deleted.add(Number(docId));
    await this.writeDeleteBitmap();
  }

  /**
   * Closes any open file handles.
   */
  public async close(): Promise<void> {
    if (this.#documents !== undefined) {
      await this.#documents.close();
      this.#documents = undefined;
    }
  }

  private async documentReader(): Promise<DocumentBlockReader> {
    if (this.#documents === undefined) {
      const parsed: unknown = JSON.parse(await readFile(join(this.#root, "docs.offset"), "utf8"));
      const table = assertValid(OffsetTableFileGuard, parsed, "corruption", "Invalid document offset table: malformed metadata.");
      this.#documents = new DocumentBlockReader(join(this.#root, "docs.bin"), table);
    }
    return this.#documents;
  }

  private async getDocumentIgnoringDelete(docId: DocId): Promise<JsonObject | undefined> {
    const reader = await this.documentReader();
    return reader.read(docId);
  }

  private isDeleted(docId: DocId): boolean {
    return this.#deleted.has(Number(docId));
  }

  private async loadDeleteBitmap(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.#root, "delete.bitmap"), "utf8"));
      if (!DeleteBitmapFileGuard.is(parsed)) {
        return;
      }
      for (const docId of parsed.deleted) {
        if (Number.isInteger(docId) && docId >= 1) {
          this.#deleted.add(docId);
        }
      }
    } catch {
      return;
    }
  }

  private async writeDeleteBitmap(): Promise<void> {
    const payload: DeleteBitmapFile = {
      format: "sabli-delete-bitmap",
      version: 1,
      deleted: [...this.#deleted].sort((left, right) => left - right)
    };
    await writeFileAtomic(join(this.#root, "delete.bitmap"), `${JSON.stringify(payload)}\n`);
  }

  private async postings(): Promise<PostingIndexFile> {
    if (this.#postings === undefined) {
      const parsed: unknown = JSON.parse(await readFile(join(this.#root, "postings.idx"), "utf8"));
      this.#postings = assertValid(PostingIndexFileGuard, parsed, "corruption", "Invalid posting index: malformed metadata.");
    }
    return this.#postings;
  }

  private allDocuments(): PostingList {
    const ids: DocId[] = [];
    for (let value = this.#metadata.minDocId; value <= this.#metadata.maxDocId; value += 1) {
      if (!this.#deleted.has(value)) {
        ids.push(toDocId(value));
      }
    }
    return createPostingList(ids);
  }

  private filterDeleted(posting: PostingList): PostingList {
    return createPostingList(posting.toArray().filter((docId) => !this.#deleted.has(Number(docId))));
  }

  private cachedPosting(key: string, values: () => readonly number[] | undefined): PostingList {
    const cacheKey = `${String(this.#metadata.segmentId)}:${key}`;
    const cached = this.#postingCache.get(cacheKey);
    if (cached !== undefined) {
      return this.filterDeleted(cached);
    }
    const raw = createPostingList((values() ?? []).map((value) => toDocId(value)));
    this.#postingCache.set(cacheKey, raw);
    return this.filterDeleted(raw);
  }

  private async candidatesForPredicate(predicate: QueryPredicate): Promise<PostingList> {
    const postings = await this.postings();
    let candidates: PostingList | undefined;
    if (predicate.exists === true) {
      candidates = this.#bloom.mightContain(`path:${predicate.path}`)
        ? this.cachedPosting(`path:${predicate.path}`, () => postings.pathExists.find(([path]) => path === predicate.path)?.[1])
        : createPostingList([]);
    }
    const equalityValue = "eq" in predicate ? predicate.eq : "contains" in predicate ? predicate.contains : undefined;
    if (equalityValue !== undefined) {
      const term = encodeTermKey(predicate.path, equalityValue);
      const equality = this.#bloom.mightContain(`term:${term}`)
        ? this.cachedPosting(`term:${term}`, () => postings.termPostings.find(([key]) => key === term)?.[1])
        : createPostingList([]);
      candidates = candidates === undefined ? equality : candidates.intersect(equality);
    }
    const numeric = this.numericCandidates(predicate, postings);
    if (numeric !== undefined) {
      candidates = candidates === undefined ? numeric : candidates.intersect(numeric);
    }
    return candidates ?? this.allDocuments();
  }

  private numericCandidates(predicate: QueryPredicate, postings: PostingIndexFile): PostingList | undefined {
    const hasNumeric =
      predicate.gt !== undefined ||
      predicate.gte !== undefined ||
      predicate.lt !== undefined ||
      predicate.lte !== undefined ||
      predicate.between !== undefined;
    if (!hasNumeric) {
      return undefined;
    }
    const rows = postings.numericValues.find(([path]) => path === predicate.path)?.[1] ?? [];
    return createPostingList(
      rows
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
        .map(({ docId }) => toDocId(docId))
    );
  }

  private async candidatesForExpression(expression: QueryExpression): Promise<PostingList> {
    if ("and" in expression) {
      const candidates = await Promise.all(expression.and.map((child) => this.candidatesForExpression(child)));
      candidates.sort((left, right) => left.size - right.size);
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
        acc = acc.union(await this.candidatesForExpression(child));
      }
      return acc;
    }
    if ("not" in expression) {
      return this.allDocuments().difference(await this.candidatesForExpression(expression.not));
    }
    if ("elemMatch" in expression) {
      return this.candidatesForExpression(expression.elemMatch.where);
    }
    return this.candidatesForPredicate(expression);
  }
}
