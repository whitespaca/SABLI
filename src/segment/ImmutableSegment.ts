import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BloomFilter } from "../bloom/bloom-filter.js";
import { DocumentBlockReader } from "../storage/DocumentBlockStore.js";
import { writeFileAtomic } from "../storage/AtomicFile.js";
import type { DocId, JsonObject } from "../types/json.js";
import { toDocId } from "../types/json.js";
import { parseSegmentMetadata } from "../validation/SegmentMetadataValidation.js";
import { SortedArrayPostingList, type PostingList } from "../indexes/posting.js";
import type { QueryExpression, QueryPredicate } from "../query/ast.js";
import { encodeTermKey } from "./MemSegment.js";
import type { SegmentMetadata } from "./SegmentMetadata.js";
import { SabliCorruptionError } from "../errors/index.js";
import {
  DeleteBitmapFileGuard,
  OffsetTableFileGuard,
  PostingIndexFileGuard,
  type PostingIndexFileInput
} from "../validation/schemas.js";

type PostingIndexFile = PostingIndexFileInput;

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
  readonly #deleted = new Set<number>();
  #postings: PostingIndexFile | undefined;
  #documents: DocumentBlockReader | undefined;

  private constructor(root: string, metadata: SegmentMetadata) {
    this.#root = root;
    this.#metadata = metadata;
    this.#bloom = BloomFilter.deserialize(metadata.bloom);
  }

  /**
   * Opens an immutable segment from disk.
   *
   * @param root - Segment directory path.
   * @returns Open segment reader.
   */
  public static async open(root: string): Promise<ImmutableSegment> {
    const metadata = parseSegmentMetadata(JSON.parse(await readFile(join(root, "segment.meta.json"), "utf8")));
    const segment = new ImmutableSegment(root, metadata);
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
      const result = OffsetTableFileGuard.check(parsed);
      if (!result.ok) {
        throw new SabliCorruptionError("Invalid document offset table: malformed metadata.");
      }
      const table = result.value;
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
      const result = DeleteBitmapFileGuard.check(parsed);
      if (!result.ok) {
        return;
      }
      for (const docId of result.value.deleted) {
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
      const result = PostingIndexFileGuard.check(parsed);
      if (!result.ok) {
        throw new SabliCorruptionError("Invalid posting index: malformed metadata.");
      }
      this.#postings = result.value;
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
    return new SortedArrayPostingList(ids);
  }

  private postingFromNumbers(values: readonly number[] | undefined): PostingList {
    return new SortedArrayPostingList((values ?? []).filter((value) => !this.#deleted.has(value)).map((value) => toDocId(value)));
  }

  private async candidatesForPredicate(predicate: QueryPredicate): Promise<PostingList> {
    const postings = await this.postings();
    let candidates: PostingList | undefined;
    if (predicate.exists === true) {
      candidates = this.#bloom.mightContain(`path:${predicate.path}`)
        ? this.postingFromNumbers(postings.pathExists.find(([path]) => path === predicate.path)?.[1])
        : new SortedArrayPostingList([]);
    }
    const equalityValue = "eq" in predicate ? predicate.eq : "contains" in predicate ? predicate.contains : undefined;
    if (equalityValue !== undefined) {
      const term = encodeTermKey(predicate.path, equalityValue);
      const equality = this.#bloom.mightContain(`term:${term}`)
        ? this.postingFromNumbers(postings.termPostings.find(([key]) => key === term)?.[1])
        : new SortedArrayPostingList([]);
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
    return new SortedArrayPostingList(
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
      const [first, ...rest] = expression.and;
      if (first === undefined) {
        return new SortedArrayPostingList([]);
      }
      let acc = await this.candidatesForExpression(first);
      for (const child of rest) {
        acc = acc.intersect(await this.candidatesForExpression(child));
      }
      return acc;
    }
    if ("or" in expression) {
      let acc: PostingList = new SortedArrayPostingList([]);
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
