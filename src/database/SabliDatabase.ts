import { mkdir, rm } from "node:fs/promises";
import { SabliDatabaseClosedError, SabliStorageError } from "../errors/index.js";
import type { InsertResult, Query, SearchResult } from "../query/ast.js";
import { verifyDocument } from "../query/verifier.js";
import { MemSegment } from "../segment/MemSegment.js";
import type { ImmutableSegment } from "../segment/ImmutableSegment.js";
import { DatabaseDirectory } from "../storage/DatabaseDirectory.js";
import { FileLock } from "../storage/FileLock.js";
import { type DatabaseManifest, ManifestStore } from "../storage/ManifestStore.js";
import { SegmentStore } from "../storage/SegmentStore.js";
import { WalStore, type WalRecord } from "../storage/WalStore.js";
import type { DocId, JsonObject } from "../types/json.js";
import { toDocId, toSegmentId } from "../types/json.js";
import { parseJsonDocument } from "../validation/documents.js";
import { parseDatabaseOptions, type SabliDatabaseOptions } from "../validation/DatabaseOptionsValidation.js";
import { parseQuery } from "../validation/queries.js";
import { DocIdInputGuard } from "../validation/schemas.js";
import { assertIs } from "../validation/assertValid.js";
import type { DatabaseLifecycleState } from "./DatabaseLifecycle.js";
import { isDatabaseOpen } from "./DatabaseLifecycle.js";
import type { SabliDatabaseStats } from "./DatabaseStats.js";

/**
 * Persistent embedded SABLI database.
 */
export class SabliDatabase<TDocument extends JsonObject = JsonObject> {
  readonly #options: SabliDatabaseOptions;
  readonly #directory: DatabaseDirectory;
  readonly #manifestStore: ManifestStore;
  #wal: WalStore;
  readonly #segmentStore: SegmentStore;
  readonly #lock: FileLock;
  readonly #segments: ImmutableSegment[];
  #manifest: DatabaseManifest;
  #mem: MemSegment<TDocument>;
  #lifecycle: DatabaseLifecycleState = "open";
  #nextWalSequence: number;

  private constructor(args: {
    readonly options: SabliDatabaseOptions;
    readonly directory: DatabaseDirectory;
    readonly manifestStore: ManifestStore;
    readonly wal: WalStore;
    readonly segmentStore: SegmentStore;
    readonly lock: FileLock;
    readonly manifest: DatabaseManifest;
    readonly segments: ImmutableSegment[];
    readonly mem: MemSegment<TDocument>;
    readonly nextWalSequence: number;
  }) {
    this.#options = args.options;
    this.#directory = args.directory;
    this.#manifestStore = args.manifestStore;
    this.#wal = args.wal;
    this.#segmentStore = args.segmentStore;
    this.#lock = args.lock;
    this.#manifest = args.manifest;
    this.#segments = args.segments;
    this.#mem = args.mem;
    this.#nextWalSequence = args.nextWalSequence;
  }

  /**
   * Opens or creates a disk-backed SABLI database.
   *
   * @param options - Database open options.
   * @returns Open database handle.
   * @throws {SabliValidationError} If options are invalid.
   * @throws {SabliStorageError} If the database cannot be opened.
   * @throws {SabliLockError} If another process holds the database lock.
   */
  public static async open<TDocument extends JsonObject = JsonObject>(options: unknown): Promise<SabliDatabase<TDocument>> {
    const parsed = parseDatabaseOptions(options);
    const directory = new DatabaseDirectory(parsed.path);
    if (parsed.createIfMissing) {
      await mkdir(parsed.path, { recursive: true });
      await mkdir(directory.paths.segments, { recursive: true });
    }
    const lock = new FileLock(directory.paths.lock);
    await lock.acquire();
    const segments: ImmutableSegment[] = [];
    try {
      await mkdir(directory.paths.segments, { recursive: true });
      const manifestStore = new ManifestStore(directory.paths.root, directory.paths.current);
      const current = await directory.readCurrent();
      if (current === undefined) {
        if (!parsed.createIfMissing) {
          throw new SabliStorageError("Database does not exist and createIfMissing is false.");
        }
        await manifestStore.write(manifestStore.createInitial());
      }
      const manifest = await manifestStore.read();
      const segmentStore = new SegmentStore(
        directory.paths.root,
        { expectedEntries: 10_000, falsePositiveRate: 0.01 },
        { postingCacheMaxEntries: parsed.postingCacheMaxEntries }
      );
      for (const entry of manifest.segments) {
        segments.push(await segmentStore.open(entry));
      }
      await segmentStore.cleanupTemporarySegments();
      const wal = new WalStore(directory.walPath(manifest.activeWalGeneration));
      await wal.ensure();
      const replay = await wal.replay(manifest.flushedWalSequence);
      const mem = new MemSegment<TDocument>({ expectedEntries: 10_000, falsePositiveRate: 0.01 });
      let nextDocId = Number(manifest.nextDocId);
      for (const record of replay.records) {
        if (record.type === "insert") {
          mem.insertWithDocId(record.docId, record.document as TDocument, record.sequence);
          nextDocId = Math.max(nextDocId, Number(record.docId) + 1);
          continue;
        }
        if (record.type === "update") {
          mem.delete(record.oldDocId, record.sequence);
          await Promise.all(segments.map((segment) => segment.markDeleted(record.oldDocId)));
          mem.insertWithDocId(record.newDocId, record.document as TDocument, record.sequence);
          nextDocId = Math.max(nextDocId, Number(record.newDocId) + 1);
          continue;
        }
        mem.delete(record.docId, record.sequence);
        await Promise.all(segments.map((segment) => segment.markDeleted(record.docId)));
      }
      const opened = new SabliDatabase<TDocument>({
        options: parsed,
        directory,
        manifestStore,
        wal,
        segmentStore,
        lock,
        manifest: {
          ...manifest,
          nextDocId: toDocId(nextDocId)
        },
        segments,
        mem,
        nextWalSequence: Math.max(replay.lastSequence + 1, manifest.flushedWalSequence + 1)
      });
      return opened;
    } catch (error) {
      await Promise.all(segments.map((segment) => segment.close()));
      await lock.release();
      throw error;
    }
  }

  /**
   * Inserts a JSON document durably through the WAL before indexing it in memory.
   *
   * @param document - JSON document to validate and insert.
   * @returns Insert result containing the assigned document identifier.
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   * @throws {SabliValidationError} If the document is invalid.
   */
  public async insert(document: unknown): Promise<InsertResult> {
    this.assertOpen();
    const parsed = parseJsonDocument(document) as TDocument;
    const docId = this.#manifest.nextDocId;
    const sequence = this.#nextWalSequence;
    const record: WalRecord = {
      format: "sabli-wal-record",
      version: 1,
      sequence,
      type: "insert",
      docId,
      document: parsed
    };
    await this.#wal.append(record, this.#options.durability === "strict");
    const entryCount = this.#mem.insertWithDocId(docId, parsed, sequence);
    this.#nextWalSequence += 1;
    this.#manifest = { ...this.#manifest, nextDocId: toDocId(Number(docId) + 1) };
    if (this.#mem.documentCount >= this.#options.memSegmentMaxDocuments) {
      await this.flush();
    }
    return { docId, entryCount };
  }

  /**
   * Deletes a visible document from future search results.
   *
   * @param docId - Document identifier to delete.
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   * @throws {SabliValidationError} If the identifier is invalid.
   */
  public async delete(docId: unknown): Promise<void> {
    this.assertOpen();
    const parsedDocId = parseDocIdInput(docId, "delete");
    const sequence = this.#nextWalSequence;
    const record: WalRecord = {
      format: "sabli-wal-record",
      version: 1,
      sequence,
      type: "delete",
      docId: parsedDocId
    };
    await this.#wal.append(record, this.#options.durability === "strict");
    await this.applyDelete(parsedDocId, sequence);
    this.#nextWalSequence += 1;
  }

  /**
   * Replaces a visible document with a new document version.
   *
   * @param docId - Existing document identifier to supersede.
   * @param document - New JSON document version.
   * @returns Insertion metadata for the new document version.
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   * @throws {SabliValidationError} If the identifier or document is invalid.
   * @throws {SabliStorageError} If the old document is not visible.
   */
  public async update(docId: unknown, document: unknown): Promise<InsertResult> {
    this.assertOpen();
    const oldDocId = parseDocIdInput(docId, "update");
    if (!(await this.isVisible(oldDocId))) {
      throw new SabliStorageError("Cannot update document: docId is not visible.");
    }
    const parsed = parseJsonDocument(document) as TDocument;
    const sequence = this.#nextWalSequence;
    const newDocId = this.#manifest.nextDocId;
    const record: WalRecord = {
      format: "sabli-wal-record",
      version: 1,
      sequence,
      type: "update",
      oldDocId,
      newDocId,
      document: parsed
    };
    await this.#wal.append(record, this.#options.durability === "strict");
    await this.applyDelete(oldDocId, sequence);
    const entryCount = this.#mem.insertWithDocId(newDocId, parsed, sequence);
    this.#nextWalSequence += 1;
    this.#manifest = { ...this.#manifest, nextDocId: toDocId(Number(newDocId) + 1) };
    if (this.#mem.documentCount >= this.#options.memSegmentMaxDocuments) {
      await this.flush();
    }
    return { docId: newDocId, entryCount };
  }

  /**
   * Searches memory and immutable disk segments with exact final verification.
   *
   * @param query - Query to validate and execute.
   * @returns Search result with matching documents.
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   */
  public async search(query: unknown): Promise<SearchResult<TDocument>> {
    this.assertOpen();
    const parsed: Query = parseQuery(query);
    const documents: { readonly docId: DocId; readonly document: TDocument }[] = [];
    for (const docId of this.#mem.candidates(parsed.where).toArray()) {
      const document = this.#mem.getDocument(docId);
      if (document !== undefined && verifyDocument(document, parsed)) {
        documents.push({ docId, document });
      }
    }
    for (const segment of this.#segments) {
      const candidates = await segment.candidates(parsed.where);
      for (const docId of candidates.toArray()) {
        const document = await segment.getDocument(docId);
        if (document !== undefined && verifyDocument(document, parsed)) {
          documents.push({ docId, document: document as TDocument });
        }
      }
    }
    documents.sort((left, right) => Number(left.docId) - Number(right.docId));
    return { documents, count: documents.length };
  }

  /**
   * Returns read-only diagnostic metadata for this database handle.
   *
   * @returns Safe database statistics that do not expose mutable internals.
   * @remarks
   * Counts are approximate because delete tombstones and superseded versions can
   * remain physically present until manual compaction rewrites immutable segments.
   */
  public async stats(): Promise<SabliDatabaseStats> {
    const immutableLive = this.#segments.reduce((sum, segment) => sum + segment.liveDocumentCount, 0);
    const immutableDeleted = this.#segments.reduce((sum, segment) => sum + segment.deletedDocumentCount, 0);
    const cacheStats = this.#segments.map((segment) => segment.postingCacheStats);
    const postingStats = await Promise.all(this.#segments.map((segment) => segment.postingStats()));
    const memLive = this.#mem.documentCount;
    return {
      path: this.#directory.paths.root,
      state: isDatabaseOpen(this.#lifecycle) ? "open" : "closed",
      manifestVersion: this.#manifest.version,
      nextDocId: this.#manifest.nextDocId,
      immutableSegmentCount: this.#manifest.segments.length,
      activeWalGeneration: this.#manifest.activeWalGeneration,
      checkpointSequence: this.#manifest.flushedWalSequence,
      approximateLiveDocumentCount: immutableLive + memLive,
      approximateDeletedDocumentCount: immutableDeleted + this.#mem.deletedDocumentCount,
      memSegmentDocumentCount: memLive,
      immutablePathPostingKeyCount: postingStats.reduce((sum, stats) => sum + stats.pathKeyCount, 0),
      immutablePathPostingCount: postingStats.reduce((sum, stats) => sum + stats.pathPostingCount, 0),
      immutableTermPostingKeyCount: postingStats.reduce((sum, stats) => sum + stats.termKeyCount, 0),
      immutableTermPostingCount: postingStats.reduce((sum, stats) => sum + stats.termPostingCount, 0),
      compactionAvailable: isDatabaseOpen(this.#lifecycle),
      postingCacheSize: cacheStats.reduce((sum, stats) => sum + stats.size, 0),
      postingCacheMaxEntries: cacheStats.reduce((sum, stats) => sum + stats.maxEntries, 0),
      postingCacheHits: cacheStats.reduce((sum, stats) => sum + stats.hits, 0),
      postingCacheMisses: cacheStats.reduce((sum, stats) => sum + stats.misses, 0)
    };
  }

  /**
   * Flushes the current memory segment into an immutable disk segment.
   *
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   */
  public async flush(): Promise<void> {
    this.assertOpen();
    if (this.#mem.documentCount === 0) {
      await this.#manifestStore.write(this.#manifest);
      return;
    }
    const segmentId = this.#manifest.nextSegmentId;
    const snapshot = this.#mem.snapshot();
    const entry = await this.#segmentStore.writer.write(segmentId, snapshot);
    this.#manifest = {
      format: "sabli-manifest",
      version: 1,
      nextDocId: this.#manifest.nextDocId,
      nextSegmentId: toSegmentId(Number(segmentId) + 1),
      segments: [...this.#manifest.segments, entry],
      flushedWalSequence: snapshot.lastWalSequence,
      activeWalGeneration: this.#manifest.activeWalGeneration + 1,
      checksum: ""
    };
    await this.#manifestStore.write(this.#manifest);
    this.#segments.push(await this.#segmentStore.open(entry));
    this.#mem.clear();
    await this.rotateWalAfterCheckpoint(this.#manifest.activeWalGeneration - 1);
  }

  /**
   * Compacts all immutable segments into a single immutable segment containing only visible documents.
   *
   * @param options - Optional compaction controls. The first implementation compacts all immutable segments when called.
   * @throws {SabliDatabaseClosedError} If the database has been closed.
   * @throws {SabliStorageError} If compaction storage work fails.
   */
  public async compact(options?: { readonly force?: boolean }): Promise<void> {
    this.assertOpen();
    void options;
    await this.flush();
    const liveDocuments: { readonly docId: DocId; readonly document: TDocument }[] = [];
    for (const segment of this.#segments) {
      for (const row of await segment.readLiveDocuments()) {
        liveDocuments.push({ docId: row.docId, document: row.document as TDocument });
      }
    }
    liveDocuments.sort((left, right) => Number(left.docId) - Number(right.docId));

    const segmentId = this.#manifest.nextSegmentId;
    const entry = await this.#segmentStore.writer.write(segmentId, {
      documents: liveDocuments,
      lastWalSequence: this.#manifest.flushedWalSequence
    });
    const oldSegments = [...this.#segments];
    this.#manifest = {
      format: "sabli-manifest",
      version: 1,
      nextDocId: this.#manifest.nextDocId,
      nextSegmentId: toSegmentId(Number(segmentId) + 1),
      segments: liveDocuments.length === 0 ? [] : [entry],
      flushedWalSequence: this.#manifest.flushedWalSequence,
      activeWalGeneration: this.#manifest.activeWalGeneration + 1,
      checksum: ""
    };
    await this.#manifestStore.write(this.#manifest);

    for (const segment of oldSegments) {
      await segment.close();
    }
    this.#segments.length = 0;
    if (liveDocuments.length > 0) {
      this.#segments.push(await this.#segmentStore.open(entry));
    }
    await this.rotateWalAfterCheckpoint(this.#manifest.activeWalGeneration - 1);
    await this.#segmentStore.cleanupObsoleteSegments(new Set(this.#manifest.segments.map((segment) => segment.path)));
  }

  /**
   * Closes the database after flushing pending writes and releasing the lock.
   */
  public async close(): Promise<void> {
    if (!isDatabaseOpen(this.#lifecycle)) {
      return;
    }
    await this.flush();
    for (const segment of this.#segments) {
      await segment.close();
    }
    await this.#lock.release();
    this.#lifecycle = "closed";
  }

  /**
   * Root path of the opened database.
   */
  public get path(): string {
    return this.#directory.paths.root;
  }

  private assertOpen(): void {
    if (!isDatabaseOpen(this.#lifecycle)) {
      throw new SabliDatabaseClosedError("SABLI database is closed.");
    }
  }

  private async applyDelete(docId: DocId, sequence: number): Promise<void> {
    if (this.#mem.hasDocument(docId)) {
      this.#mem.delete(docId, sequence);
    }
    await Promise.all(this.#segments.map((segment) => segment.markDeleted(docId)));
  }

  private async rotateWalAfterCheckpoint(previousGeneration: number): Promise<void> {
    this.#wal = new WalStore(this.#directory.walPath(this.#manifest.activeWalGeneration));
    await this.#wal.ensure();
    await rm(this.#directory.walPath(previousGeneration), { force: true });
  }

  private async isVisible(docId: DocId): Promise<boolean> {
    if (this.#mem.getDocument(docId) !== undefined) {
      return true;
    }
    for (const segment of this.#segments) {
      if ((await segment.getDocument(docId)) !== undefined) {
        return true;
      }
    }
    return false;
  }
}

function parseDocIdInput(input: unknown, operation: string): DocId {
  return toDocId(assertIs(DocIdInputGuard, input, "public", `Invalid ${operation} docId: expected a positive integer.`));
}
