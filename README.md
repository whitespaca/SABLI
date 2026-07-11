# SABLI

[![npm version](https://img.shields.io/npm/v/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![npm downloads](https://img.shields.io/npm/dm/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

SABLI is an ESModule-only TypeScript library for indexing and searching unordered schema-less JSON documents. SABLI stands for Segmented Adaptive Bloom-LSM Inverted Index.

Version 1.5.0 adds optional automatic compaction, explicit immutable-segment levels, monotonic manifest generations, and reader-safe obsolete-segment reclamation. The feature is disabled by default. Scope-aware `elemMatch`, atomic update WAL records, strict segment integrity checks, bounded posting caches, and exact raw-document verification remain unchanged.

## Installation

```bash
npm install sablidb
```

SABLI targets Node.js 22 or later and is published as ESModule only.

## Requirements

- Node.js 22 or later.
- ESModule projects only. Use `"type": "module"` in `package.json`.
- TypeScript users should use Node-style ESModule resolution.

## Basic Usage

```ts
import { SabliDatabase } from "sablidb";

const db = await SabliDatabase.open({
  path: "./data/users.sabli",
  createIfMissing: true
});

await db.insert({
  user: { name: "Kim", age: 31 },
  tags: ["backend", "typescript"]
});

const results = await db.search({
  where: {
    and: [
      { path: "user.name", eq: "Kim" },
      { path: "tags[]", contains: "backend" }
    ]
  }
});

console.dir(results.documents, { depth: null });

await db.close();
```

## Same-Element Array Queries

Use `elemMatch` when every child predicate must hold within one concrete element of an array:

```ts
const results = await db.search({
  where: {
    path: "orders[]",
    elemMatch: {
      and: [
        { path: "id", eq: "A2" },
        { path: "price", gt: 10_000 }
      ]
    }
  }
});
```

Child paths are relative to the selected array element. Nested object paths are supported:

```ts
await db.search({
  where: {
    path: "orders[]",
    elemMatch: {
      and: [
        { path: "shipping.address.city", eq: "Seoul" },
        { path: "total", gte: 20_000 }
      ]
    }
  }
});
```

Given this document:

```json
{
  "orders": [
    { "id": "A1", "price": 8000 },
    { "id": "A2", "price": 12000 }
  ]
}
```

an `elemMatch` requiring `id == "A1"` and `price > 10000` does not match. The two facts occur in different element scopes. Requiring `id == "A2"` with the same price predicate does match.

The target path must end in `[]`. A missing target, a non-array target, or an empty array does not match. Primitive and `null` array elements can be addressed with the special relative child path `$`; positive object-relative predicates do not match them, while `exists: false` and `neq` keep ordinary missing-path semantics. Ordinary primitive-array membership continues to use `contains`. Nested `elemMatch` and `not` inside `elemMatch` are rejected in v1.4. Relative paths containing `[]` may inspect nested arrays with ordinary existential leaf semantics, but cannot express a second common inner scope until nested `elemMatch` is supported.

See [`examples/elem-match.ts`](./examples/elem-match.ts) for a complete persistent database example.

Plain `console.log(results.documents)` may show nested values as `[Object]` or `[Array]`:

```txt
[ { docId: 1, document: { user: [Object], tags: [Array] } } ]
```

That is normal Node.js console inspection behavior. Use `console.dir(value, { depth: null })` or `JSON.stringify(value, null, 2)` when you want fully expanded nested objects and arrays.

Example expanded output:

```txt
[
  {
    docId: 1,
    document: {
      user: { name: 'Kim', age: 31 },
      tags: [ 'backend', 'typescript' ]
    }
  }
]
```

## Persistent Reopen

```ts
import { SabliDatabase } from "sablidb";

const first = await SabliDatabase.open({
  path: "./data/users.sabli",
  createIfMissing: true
});

await first.insert({
  user: { name: "Lee", age: 28 },
  tags: ["frontend", "typescript"]
});

await first.close();

const reopened = await SabliDatabase.open({
  path: "./data/users.sabli",
  createIfMissing: false
});

const results = await reopened.search({
  where: {
    "tags[]": { contains: "frontend" }
  }
});

console.dir(results.documents, { depth: null });

await reopened.close();
```

## Consumer Project Quickstart

```bash
mkdir sablidb-consumer-test
cd sablidb-consumer-test
npm init -y
npm pkg set type=module
npm install sablidb
npm install -D typescript @types/node
npx tsc --init
mkdir src
```

Create `src/index.ts`:

```ts
import { SabliDatabase } from "sablidb";

const db = await SabliDatabase.open({
  path: "./data/users.sabli",
  createIfMissing: true
});

await db.insert({
  user: { name: "Kim", age: 31 },
  tags: ["backend", "typescript"]
});

const results = await db.search({
  where: {
    "tags[]": { contains: "backend" }
  }
});

console.dir(results.documents, { depth: null });

await db.close();
```

Replace the generated `tsconfig.json` with the recommended configuration below, then compile and run:

```bash
npx tsc
node dist/index.js
```

## Recommended TypeScript Config

For Node.js 22 and ESModule projects, use options like these:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

## Delete And Update

Delete writes a tombstone to the WAL before the call resolves:

```ts
const inserted = await db.insert({
  user: { name: "Lee", age: 28 },
  tags: ["frontend"]
});

await db.delete(inserted.docId);
```

Update is implemented as a new visible document version plus a tombstone for the old document identifier:

```ts
const first = await db.insert({
  user: { name: "Park", role: "developer" }
});

const next = await db.update(first.docId, {
  user: { name: "Park", role: "architect" }
});

console.log(next.docId);
```

Search never returns deleted documents or superseded old versions. Disk segments use versioned `delete.bitmap` files to filter tombstoned identifiers before raw documents are fetched. Current-format immutable segments require valid delete bitmap visibility metadata; missing, unreadable, or malformed metadata causes a controlled corruption failure instead of being ignored.

## Manual Compaction

Compaction rewrites visible documents from immutable segments into a new immutable segment, then atomically updates the manifest so old segments are no longer referenced.

```ts
await db.compact();
```

Manual compaction remains deliberately simple: when `compact()` is called, SABLI flushes the current memory segment, reads all visible documents from all immutable segments, writes one compacted replacement segment, rotates to a new WAL generation, and retires unreferenced old segment directories after the manifest swap succeeds.

Compaction removes deleted documents and superseded old update versions from future compacted segments. Manual calls and automatic jobs share one mutation queue and cannot overlap.

## Automatic Compaction

Automatic compaction is optional and disabled by default:

```ts
const db = await SabliDatabase.open({
  path: "./data/users.sabli",
  createIfMissing: true,
  automaticCompaction: {
    enabled: true,
    maxLevelZeroSegments: 4,
    maxInputSegments: 4,
    staleRatioThreshold: 0.3,
    checkIntervalMs: 5_000,
    maxInputBytes: 268_435_456
  }
});
```

Every new flush writes an explicit L0 segment. The deterministic initial policy first selects the oldest bounded group when a same-level segment count reaches `maxLevelZeroSegments`; L0 groups produce L1, and higher-level groups produce the next bounded level. If no count group is eligible, one old segment whose deleted-document ratio reaches `staleRatioThreshold` may be rewritten. `maxInputSegments` and `maxInputBytes` bound each job. A clean single segment is never selected repeatedly.

Automatic jobs compact immutable disk segments only. They do not flush memory, advance the WAL checkpoint, or rotate the WAL generation. Flush and manual compaction retain their existing checkpoint behavior. Call `await db.waitForMaintenance()` to deterministically drain work that is currently eligible; `close()` cancels scheduled checks, waits for an active job, flushes pending memory, waits for search leases, and then releases storage resources.

Searches acquire one immutable segment-generation lease. A manifest commit publishes the entire replacement segment array at once, and obsolete readers and directories remain available until searches using the old generation finish. Cleanup failures are diagnostic, not manifest corruption, and known-safe obsolete directories are retried during close or startup. See [`examples/automatic-compaction.ts`](./examples/automatic-compaction.ts).

## Diagnostics

Use `stats()` for lightweight read-only database diagnostics:

```ts
const stats = await db.stats();

console.dir(stats, { depth: null });
```

The result includes the database path, open or closed state, manifest version, next document identifier, immutable segment count, active WAL generation, checkpoint sequence, approximate visible and deleted document counts, memory segment document count, derived immutable posting-key and posting-row counts, bounded posting-cache size, capacity, hit, and miss counters, and whether compaction can be called on the current handle.

Version 1.5.0 also reports low-cost immutable-segment integrity, scoped-index, manifest-generation, level, and maintenance diagnostics. Maintenance fields include enabled/state, active plan shape, completed and failed automatic job counts, last reason/timestamps/error, per-level segment counts, pending obsolete segments, and the last cleanup error. The values summarize state already maintained in memory and do not expose mutable collections or require a full-database scan on each `stats()` call.

## Performance Notes

SABLI uses adaptive internal posting lists for candidate document identifiers. Very small posting sets use a compact small-list representation, while larger sets use sorted arrays with binary-search membership and merge-based set operations. AND queries intersect smaller candidate sets first and short-circuit empty intersections.

Immutable disk segments keep a small bounded posting cache for repeated path and term lookups. The cache stores raw posting candidates and applies delete bitmap filtering after every lookup, so cached results cannot bypass delete or update visibility. The cache is enabled by default and can be disabled when opening a database:

```ts
const db = await SabliDatabase.open({
  path: "./data/no-cache.sabli",
  createIfMissing: true,
  postingCache: { enabled: false }
});
```

Complement-based and unselective immutable-segment queries use exact physical document identifiers from the validated, versioned `docs.offset` table. Sparse identifier gaps are not enumerated as candidates, and deleted identifiers are filtered after the raw all-document posting is retrieved.

`elemMatch` uses a separate correctness-first scoped posting index. Scoped entries are sorted unique `(Document ID, Scope ID)` pairs, so an AND intersects the concrete element identity as well as the document identity. Equality and path-existence terms use scoped postings, and numeric ranges use inspectable scoped numeric rows. Scoped and ordinary cache keys are distinct. Bloom filters only prune individual scoped terms; independent Bloom hits never prove a same-element conjunction.

Version-1 immutable segments written by SABLI v1.3.1 remain readable. They have no scoped posting file, so `elemMatch` uses conservative visible document candidates and exact raw verification. Version-1 and version-2 metadata deliberately default to L0. New flushes write segment metadata version 3 with an explicit bounded level and `scoped-postings.idx`; compaction naturally upgrades visible legacy documents into the current format. Missing or invalid levels in version-3 metadata are corruption, never legacy inference.

Exact final verification remains part of every search result path. Posting lists, Bloom filters, and the cache only reduce candidate work; SABLI still reads and verifies raw JSON documents before returning matches.

## Query Examples

Field-map syntax:

```ts
await db.search({
  where: {
    "user.name": { eq: "Kim" },
    "tags[]": { contains: "typescript" }
  }
});
```

Explicit Boolean syntax:

```ts
await db.search({
  where: {
    and: [
      { path: "user.age", gte: 30 },
      { path: "tags[]", contains: "backend" }
    ]
  }
});
```

Supported initial operators include `eq`, `neq`, `exists`, `contains`, `gt`, `gte`, `lt`, `lte`, `between`, `and`, `or`, and `not`.

The canonical same-array-element form is `{ path: "array[]", elemMatch: expression }`. The earlier reserved placeholder form `{ elemMatch: { path, where } }` is accepted as compatibility input and normalized to the canonical representation.

## Validation Behavior

SABLI uses TypeSea v0.4.0-compatible runtime validation. Public input is validated with safe TypeSea semantics, and WAL records, manifests, segment metadata, checkpoint-related manifest fields, document offset tables, delete bitmaps, ordinary posting indexes, scoped posting indexes, and Bloom metadata are validated when loaded. Every required current-format immutable-segment artifact is checked before the segment becomes queryable; missing or invalid artifacts fail with a controlled SABLI domain error.

The `path.dict` and `value.dict` files are required and validated on open because they are part of the current segment format, but they are currently reserved and advisory to query execution. They do not determine document visibility. The `delete.bitmap` file is visibility-critical and is never ignored or substituted with an empty bitmap after a load failure.

Validation failures are wrapped in SABLI error classes such as `SabliValidationError`, `SabliRecoveryError`, and `SabliCorruptionError`; raw TypeSea diagnostics are not part of the public API. SABLI does not use TypeSea unsafe or unchecked validation modes for public or persisted input.

SABLI is a Node.js 22+ library. Its TypeSea validators may be compiled at module startup in Node.js; CSP-restricted browser runtimes are not a supported SABLI execution target.

Inserted documents must be JSON-compatible plain objects at the root. Nested arrays and `null` values are allowed, but non-plain root documents, primitive root values, `undefined`, `NaN`, `Infinity`, `-Infinity`, functions, symbols, bigint values, sparse arrays, cyclic values, symbol keys, and accessor-backed properties are rejected. Values such as `Date`, `Map`, and `Set` must be serialized before insertion.

Search uses indexes and Bloom filters only to generate candidates. Every candidate is still checked against the raw JSON document with exact final verification before it is returned.

## Error Handling

SABLI exports domain-specific error classes. Validation failures are wrapped as `SabliValidationError`.

```ts
import { SabliDatabase, SabliValidationError } from "sablidb";

const db = await SabliDatabase.open({
  path: "./data/errors.sabli",
  createIfMissing: true
});

try {
  await db.insert(undefined);
} catch (error) {
  if (error instanceof SabliValidationError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  await db.close();
}
```

## Correctness Model

Indexes and Bloom filters only generate candidate documents. SABLI verifies every candidate against the raw JSON document before returning it, so final search results follow exact query semantics.

## Disk Layout

A SABLI database is a directory with a lock file, `CURRENT`, a versioned manifest, append-only WAL generation files, and immutable segment directories:

```txt
database.sabli/
  LOCK
  CURRENT
  MANIFEST-000001
  MANIFEST-000002
  WAL-000001.log
  WAL-000002.log
  segments/
    seg-000001/
      segment.meta.json
      docs.bin
      docs.offset
      path.dict
      value.dict
      postings.idx
      scoped-postings.idx
      bloom.bin
      delete.bitmap
```

`CURRENT` names exactly one active monotonic manifest generation. SABLI writes and syncs the next generation before atomically replacing `CURRENT`; a generated manifest that was never selected remains inactive, and at least the previous generation is retained for inspection and recovery. Missing or malformed active pointers and manifests are controlled corruption failures.

`scoped-postings.idx` is mandatory for segment metadata versions 2 and 3. A current scoped segment with a missing, malformed, unsupported, unsorted, duplicate, or non-physical scoped posting fails with `SabliCorruptionError`; it is never silently opened as a legacy segment.

Inserts, deletes, and updates are appended to the active WAL generation before they are acknowledged in strict durability mode. `flush()` writes the current memory segment to an immutable disk segment, checkpoints the WAL sequence, rotates to a new WAL generation, and updates the manifest atomically.

## Durability And Recovery

The default durability mode is `strict`, which asks Node.js to flush WAL appends before acknowledging writes. On startup, SABLI reads `CURRENT`, validates the active manifest, validates each immutable segment's required file set and persisted metadata, loads delete bitmaps, identifies the active WAL generation, and replays valid WAL records newer than the manifest checkpoint.

Partial trailing WAL records are handled deterministically by stopping at the last valid record. Checksum mismatches are treated as controlled recovery errors.

Checkpointing records the highest WAL sequence already represented by immutable segments. Flush and manual full compaction rotate to a new WAL generation only after their durable manifest state is active. Automatic disk-only compaction preserves the checkpoint and active WAL generation, so it cannot checkpoint unflushed memory writes. A failure before `CURRENT` changes leaves the previous state authoritative; a failure after it changes leaves the new state recoverable even if old WAL or segment cleanup remains.

## Benchmarks

SABLI includes deterministic TypeScript benchmark scripts for local measurement:

```bash
npm run bench:insert -- --count 1000
npm run bench:search -- --count 1000 --queries 100 --warmup 10
npm run bench:reopen -- --count 1000
npm run bench:compaction -- --count 1000
npm run bench:automatic-compaction -- --count 1000 --queries 100 --warmup 10
```

The scripts generate synthetic JSON documents, use temporary database directories by default, and print elapsed time in English. Pass `--keep` to keep the generated database directory for inspection, or `--path ./bench.sabli` to use a specific database path. Search benchmarks report total query time, average latency, p50, p95, and p99. The automatic-compaction benchmark compares write modes, accumulated-L0 search, pre/post-maintenance ordinary and `elemMatch` latency, compaction elapsed time, segment count, and database bytes.

Benchmark results depend on hardware, filesystem behavior, Node.js version, durability mode, and active operating system caches. Normal tests only verify benchmark scripts run and do not enforce strict performance thresholds.

## Current Limitations

Version 1.5.0 includes optional single-job automatic compaction with a small deterministic level policy. It does not implement size-tiered range overlap analysis, worker-thread compaction, process-wide maintenance coordination, or a full RocksDB-compatible level model. Nested `elemMatch`, child-scope `not`, compressed posting encodings, and arbitrary cross-array joins also remain future work.

## Future Roadmap

- Richer size-aware compaction selection and maintenance tooling.
- More compact posting encodings.
- Larger-scale lazy loading and cache controls.
- Nested scoped-array matching and carefully defined scoped negation.
- Richer storage diagnostics and recovery tooling.
