import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ImmutableSegment } from "../segment/ImmutableSegment.js";
import { SegmentWriter } from "../segment/SegmentWriter.js";
import type { BloomOptions } from "../query/ast.js";
import type { ManifestSegmentEntry } from "./ManifestStore.js";

/**
 * Opens and writes immutable segment directories.
 */
export class SegmentStore {
  readonly #root: string;
  readonly #writer: SegmentWriter;
  readonly #postingCacheMaxEntries: number;

  /**
   * Creates a segment store.
   *
   * @param databaseRoot - Database root directory.
   * @param bloomOptions - Bloom filter options.
   */
  public constructor(databaseRoot: string, bloomOptions: BloomOptions, options: { readonly postingCacheMaxEntries?: number } = {}) {
    this.#root = databaseRoot;
    this.#writer = new SegmentWriter(join(databaseRoot, "segments"), bloomOptions);
    this.#postingCacheMaxEntries = options.postingCacheMaxEntries ?? 128;
  }

  /**
   * Segment writer.
   */
  public get writer(): SegmentWriter {
    return this.#writer;
  }

  /**
   * Opens one segment from a manifest entry.
   *
   * @param entry - Manifest segment entry.
   * @returns Immutable segment reader.
   */
  public async open(entry: ManifestSegmentEntry): Promise<ImmutableSegment> {
    return ImmutableSegment.open(join(this.#root, entry.path), { postingCacheMaxEntries: this.#postingCacheMaxEntries });
  }

  /**
   * Removes temporary segment directories left by interrupted writes.
   */
  public async cleanupTemporarySegments(): Promise<void> {
    const segmentsRoot = join(this.#root, "segments");
    const entries = await readdir(segmentsRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".tmp"))
        .map((entry) => rm(join(segmentsRoot, entry.name), { recursive: true, force: true }))
    );
  }

  /**
   * Removes segment directories that are not referenced by the active manifest.
   *
   * @param livePaths - Relative segment paths that must be preserved.
   */
  public async cleanupObsoleteSegments(livePaths: ReadonlySet<string>): Promise<void> {
    const segmentsRoot = join(this.#root, "segments");
    const entries = await readdir(segmentsRoot, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("seg-") && !livePaths.has(`segments/${entry.name}`))
        .map((entry) => rm(join(segmentsRoot, entry.name), { recursive: true, force: true }))
    );
  }
}
