# Changelog

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

Current limitations: compaction is manual, posting files are correctness-first JSON structures, range indexing is basic, automatic background compaction is not implemented, and advanced scope-aware `elemMatch` indexing remains future work.

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
