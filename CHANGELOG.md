# Changelog

## 1.5.0 - Automatic Compaction And Levelled Segment Lifecycle

- Added optional, disabled-by-default automatic compaction with validated bounded controls and a deterministic oldest-first same-level/stale-segment policy.
- Added segment metadata version 3 with explicit L0-L8 levels while deliberately treating known version-1 and version-2 segments as legacy L0 inputs.
- Serialized flush, manual compaction, automatic compaction, mutations, and close through one async coordination primitive while preserving disk-only automatic maintenance.
- Added monotonic `MANIFEST-NNNNNN` generations, durable generation writes, atomic `CURRENT` replacement, and controlled active-pointer corruption handling.
- Added immutable search-generation leases, atomic segment-array publication, deferred obsolete-reader reclamation, safe known-path cleanup, and cleanup diagnostics.
- Added a bounded unref'ed maintenance scheduler, deterministic `waitForMaintenance()`, graceful close behavior, background failure containment, and read-only maintenance/level statistics.
- Added deterministic failure hooks and policy, concurrency, recovery, query-equivalence, legacy-level, and cleanup tests around both sides of the manifest commit boundary.
- Added `examples/automatic-compaction.ts`, `bench:automatic-compaction`, release documentation, and preserved exact scalar and scope-aware `elemMatch` verification.

## 1.4.0 - Scope-Aware Array `elemMatch` Semantics

- Added canonical `{ path: "array[]", elemMatch: expression }` queries with relative child paths and exact same-array-element AND/OR semantics.
- Added deterministic numeric element scopes, ancestor-aware scoped extraction, and sorted unique `(Document ID, Scope ID)` posting operations.
- Added scoped equality, existence, and numeric range candidate indexes in memory and in immutable segments without changing ordinary document posting semantics.
- Added segment metadata version 2 with a separate TypeSea-validated `scoped-postings.idx` file and controlled corruption handling.
- Kept version-1 segments readable through conservative `elemMatch` fallback candidates and exact raw-document verification; compaction upgrades visible legacy data.
- Integrated scoped posting cache keys, delete/update visibility filtering, compaction rebuilds, diagnostics, deterministic randomized equivalence coverage, and scoped search benchmarks.
- Added `examples/elem-match.ts` and documented cross-element non-matches, nested relative paths, legacy compatibility, performance behavior, and current nested-scope limitations.
- Preserved atomic update WAL records, immutable segment overwrite protection, complete current-format file validation, TypeSea `^0.4.0`, ESModule-only packaging, Node.js 22+, and exact final verification.

## 1.3.1 - Segment Integrity And Sparse Candidate Hardening

- Made current-format `delete.bitmap` loading fail with controlled SABLI domain errors when the file is missing, unreadable, malformed, unsupported, or contains invalid document identifiers instead of silently treating corruption as an empty bitmap.
- Added deterministic validation of the complete required immutable-segment file set before a segment becomes queryable.
- Replaced min/max range enumeration with exact physical document-identifier candidates for sparse immutable segments while preserving delete filtering and posting-cache correctness.
- Added sparse query, reopen, compaction, cache, required-file, and delete bitmap corruption coverage.
- Updated README release, diagnostics, validation, performance, and limitation wording for version 1.3.1 consistency.

## 1.3.0 - Benchmark-Driven Query Performance And Posting Optimization

- Added adaptive posting list backends with compact small postings and sorted-array postings with merge-based set operations.
- Ordered AND-query candidate intersections by posting cardinality and short-circuited empty intersections.
- Added a bounded immutable-segment posting cache with read-only hit, miss, and size diagnostics in `db.stats()`.
- Added derived immutable posting statistics for path and term postings.
- Expanded benchmark scripts with `--queries`, `--warmup`, and `--path`, and added equality, contains, AND, and repeated cached search measurements.
- Added posting correctness tests and query result equivalence tests across memory, flush, reopen, and compaction.
- Preserved atomic update WAL behavior, immutable segment overwrite protection, TypeSea validation boundaries, and exact final verification.

## 1.2.2 - TypeSea v0.4.0 Validation Contract Hardening

- Upgraded TypeSea to v0.4.0 and hardened SABLI validation wrappers around public input and persisted storage metadata.
- Replaced update recovery logging with one atomic update WAL record containing `oldDocId`, `newDocId`, and the replacement document.
- Prevented immutable segment writes from overwriting existing segment directories.
- Added hostile-input tests for getter-backed objects, prototype-pollution-looking keys, symbol and non-enumerable properties, sparse arrays, cyclic values, and invalid JSON values.
- Tightened document, query, WAL, manifest, segment metadata, and persisted index metadata validation with stricter object schemas where compatibility allows.
- Kept raw TypeSea diagnostics out of SABLI's public API by wrapping validation failures as SABLI domain errors.
- Preserved the existing public API shape and exact final verification for search results.

## 1.2.0 - Compaction, Checkpointing, And Release Hardening

- Added manual `compact()` support that rewrites visible immutable-segment documents into a compacted segment.
- Added WAL checkpoint metadata and WAL generation rotation after flush and compaction.
- Added obsolete segment cleanup and safe startup cleanup for known temporary segment directories.
- Added `db.stats()` diagnostics for read-only database state and storage metadata.
- Added deterministic TypeScript benchmark scripts for insert, search, reopen, and compaction measurements.

Current limitations: compaction is manual, posting files are correctness-first JSON structures, range indexing is basic, automatic background compaction is not implemented, and nested `elemMatch` remains future work.

## 1.1.0 - Durable Mutation Support

- Added durable `delete(docId)` support through WAL tombstones and segment delete bitmaps.
- Added `update(docId, document)` as insert-new-version plus tombstone-old-version.
- Added recovery tests for delete and update WAL replay.
- Ensured deleted and superseded documents are excluded from memory and disk searches.

## 1.0.0 - Persistent Database Foundation

- Added the disk-backed `SabliDatabase` API.
- Added append-only WAL persistence, database directory management, manifest loading, immutable disk segments, document blocks, offset tables, Bloom filter files, and exact final verification.
- Added TypeSea validation for public inputs and persisted metadata boundaries.
- Added examples, consumer quickstart documentation, and consumer smoke coverage.
