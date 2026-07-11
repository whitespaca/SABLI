import type { DocId } from "../types/json.js";

/**
 * Read-only diagnostic metadata for an opened SABLI database handle.
 *
 * @remarks
 * These values are intended for observability, tests, and operational checks.
 * They are approximate where noted because deletes and superseded versions may
 * remain physically present until manual or automatic compaction rewrites segments.
 */
export interface SabliDatabaseStats {
  /** Database root directory path. */
  readonly path: string;
  /** Current lifecycle state for this handle. */
  readonly state: "open" | "closing" | "closed";
  /** Active manifest format version. */
  readonly manifestVersion: number;
  /** Next document identifier that will be assigned to a new insert. */
  readonly nextDocId: DocId;
  /** Number of immutable disk segments referenced by the active manifest. */
  readonly immutableSegmentCount: number;
  /** Number of immutable segments whose complete required file sets were validated. */
  readonly validatedImmutableSegmentCount: number;
  /** Current immutable segment format version, or null when no immutable segment is loaded. */
  readonly immutableSegmentFormatVersion: number | null;
  /** Sorted immutable segment format versions currently in use. */
  readonly immutableSegmentFormatVersions: readonly number[];
  /** Number of legacy segments that require raw-document elemMatch candidate fallback. */
  readonly legacyElemMatchFallbackSegmentCount: number;
  /** Number of delete bitmap entries loaded from validated immutable segments. */
  readonly loadedDeleteBitmapEntryCount: number;
  /** Number of exact physical document identifiers loaded from immutable segment offset tables. */
  readonly exactSegmentDocumentIdCount: number;
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
  /** Number of immutable scoped array-universe posting keys. */
  readonly immutableScopedArrayPostingKeyCount: number;
  /** Total immutable concrete array-element scope rows. */
  readonly immutableScopedArrayPostingCount: number;
  /** Number of immutable scoped path-exists posting keys. */
  readonly immutableScopedPathPostingKeyCount: number;
  /** Total immutable scoped path-exists posting rows. */
  readonly immutableScopedPathPostingCount: number;
  /** Number of immutable scoped equality or contains posting keys. */
  readonly immutableScopedTermPostingKeyCount: number;
  /** Total immutable scoped equality or contains posting rows. */
  readonly immutableScopedTermPostingCount: number;
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
  /** Number of scoped postings currently using the shared immutable cache budget. */
  readonly scopedPostingCacheSize: number;
  /** Number of successful scoped posting cache lookups. */
  readonly scopedPostingCacheHits: number;
  /** Number of missed scoped posting cache lookups. */
  readonly scopedPostingCacheMisses: number;
  /** Active monotonic manifest filename generation. */
  readonly manifestGeneration: number;
  /** Whether automatic background compaction is enabled. */
  readonly automaticCompactionEnabled: boolean;
  /** Current automatic maintenance scheduler state. */
  readonly maintenanceState: "idle" | "scheduled" | "running" | "closing" | "failed";
  /** Input segment count for the active automatic compaction. */
  readonly activeCompactionInputSegmentCount: number;
  /** Output level for the active automatic compaction. */
  readonly activeCompactionOutputLevel: number | null;
  /** Successfully completed automatic compaction jobs. */
  readonly completedAutomaticCompactionCount: number;
  /** Failed automatic compaction jobs. */
  readonly failedAutomaticCompactionCount: number;
  /** Last automatic compaction selection reason. */
  readonly lastAutomaticCompactionReason: string | null;
  /** ISO start timestamp for the most recent maintenance evaluation. */
  readonly lastAutomaticCompactionStartTime: string | null;
  /** ISO end timestamp for the most recent maintenance evaluation. */
  readonly lastAutomaticCompactionEndTime: string | null;
  /** Stable English summary for the last background maintenance failure. */
  readonly lastMaintenanceError: string | null;
  /** Immutable segment counts grouped by level. */
  readonly segmentCountsByLevel: readonly { readonly level: number; readonly count: number }[];
  /** Obsolete segment readers waiting for active search leases or cleanup retry. */
  readonly pendingObsoleteSegmentCount: number;
  /** Last obsolete-file cleanup error summary. */
  readonly lastObsoleteCleanupError: string | null;
}
