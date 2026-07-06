import type { DocId } from "../types/json.js";

/**
 * Read-only diagnostic metadata for an opened SABLI database handle.
 *
 * @remarks
 * These values are intended for observability, tests, and operational checks.
 * They are approximate where noted because deletes and superseded versions may
 * remain physically present until manual compaction rewrites segments.
 */
export interface SabliDatabaseStats {
  /** Database root directory path. */
  readonly path: string;
  /** Current lifecycle state for this handle. */
  readonly state: "open" | "closed";
  /** Active manifest format version. */
  readonly manifestVersion: number;
  /** Next document identifier that will be assigned to a new insert. */
  readonly nextDocId: DocId;
  /** Number of immutable disk segments referenced by the active manifest. */
  readonly immutableSegmentCount: number;
  /** WAL generation used for new writes. */
  readonly activeWalGeneration: number;
  /** Highest WAL sequence already represented by durable immutable storage. */
  readonly checkpointSequence: number;
  /** Approximate count of visible documents across memory and disk segments. */
  readonly approximateLiveDocumentCount: number;
  /** Approximate count of deleted or superseded physical document versions. */
  readonly approximateDeletedDocumentCount: number;
  /** Number of visible documents currently buffered in memory. */
  readonly memSegmentDocumentCount: number;
  /** Number of immutable-segment path-exists posting keys. */
  readonly immutablePathPostingKeyCount: number;
  /** Total immutable-segment path-exists posting rows. */
  readonly immutablePathPostingCount: number;
  /** Number of immutable-segment equality or contains term posting keys. */
  readonly immutableTermPostingKeyCount: number;
  /** Total immutable-segment equality or contains posting rows. */
  readonly immutableTermPostingCount: number;
  /** True when manual compaction can be called on this database handle. */
  readonly compactionAvailable: boolean;
  /** Current number of cached immutable-segment posting lists. */
  readonly postingCacheSize: number;
  /** Maximum total cached immutable-segment posting lists. */
  readonly postingCacheMaxEntries: number;
  /** Number of immutable-segment posting cache hits. */
  readonly postingCacheHits: number;
  /** Number of immutable-segment posting cache misses. */
  readonly postingCacheMisses: number;
}
