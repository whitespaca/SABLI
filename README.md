# SABLI

[![npm version](https://img.shields.io/npm/v/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![npm downloads](https://img.shields.io/npm/dm/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

SABLI is an ESModule-only TypeScript library for indexing and searching unordered schema-less JSON documents. SABLI stands for Segmented Adaptive Bloom-LSM Inverted Index.

Version 1.2 provides a correctness-first embedded database with a memory write buffer, append-only WAL, immutable disk segments, delete bitmaps, manual compaction, WAL checkpointing, advisory Bloom pruning, adaptive posting abstractions, and exact final verification.

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

Search never returns deleted documents or superseded old versions. Disk segments use versioned `delete.bitmap` files to filter tombstoned identifiers before raw documents are fetched.

## Manual Compaction

Compaction rewrites visible documents from immutable segments into a new immutable segment, then atomically updates the manifest so old segments are no longer referenced.

```ts
await db.compact();
```

The v1.2 compaction policy is deliberately simple and deterministic: when `compact()` is called, SABLI flushes the current memory segment, reads all visible documents from all immutable segments, writes one compacted replacement segment, rotates to a new WAL generation, and removes unreferenced old segment directories after the manifest swap succeeds.

Compaction removes deleted documents and superseded old update versions from future compacted segments. It is manual in this milestone; no background or automatic compaction is started by the library.

## Diagnostics

Use `stats()` for lightweight read-only database diagnostics:

```ts
const stats = await db.stats();

console.dir(stats, { depth: null });
```

The result includes the database path, open or closed state, manifest version, next document identifier, immutable segment count, active WAL generation, checkpoint sequence, approximate visible and deleted document counts, memory segment document count, and whether compaction can be called on the current handle.

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

## Validation Behavior

SABLI uses TypeSea v0.4.0-compatible runtime validation. Public input is validated with safe TypeSea semantics, and WAL records, manifests, segment metadata, checkpoint-related manifest fields, document offset tables, delete bitmaps, posting indexes, and Bloom metadata are validated when loaded.

Validation failures are wrapped in SABLI error classes such as `SabliValidationError`, `SabliRecoveryError`, and `SabliCorruptionError`; raw TypeSea diagnostics are not part of the public API. SABLI does not use TypeSea unsafe or unchecked validation modes for public or persisted input.

SABLI is a Node.js 22+ library. Its TypeSea validators may be compiled at module startup in Node.js; CSP-restricted browser runtimes are not a supported SABLI execution target.

Inserted documents must be JSON-compatible plain objects at the root. Nested arrays and `null` values are allowed, but primitive root values, `undefined`, `NaN`, `Infinity`, `-Infinity`, functions, symbols, bigint values, sparse arrays, cyclic values, and accessor-backed properties are rejected. Values such as `Date`, `Map`, and `Set` must be serialized before insertion.

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
      bloom.bin
      delete.bitmap
```

Inserts, deletes, and updates are appended to the active WAL generation before they are acknowledged in strict durability mode. `flush()` writes the current memory segment to an immutable disk segment, checkpoints the WAL sequence, rotates to a new WAL generation, and updates the manifest atomically.

## Durability And Recovery

The default durability mode is `strict`, which asks Node.js to flush WAL appends before acknowledging writes. On startup, SABLI reads `CURRENT`, validates the active manifest, opens immutable segments, loads delete bitmaps, identifies the active WAL generation, and replays valid WAL records newer than the manifest checkpoint.

Partial trailing WAL records are handled deterministically by stopping at the last valid record. Checksum mismatches are treated as controlled recovery errors.

Checkpointing records the highest WAL sequence already represented by immutable segments. After flush or compaction, new writes go to the next WAL generation. Obsolete WAL generations are not required after a successful checkpoint.

## Benchmarks

SABLI includes deterministic TypeScript benchmark scripts for local measurement:

```bash
npm run bench:insert -- --count 1000
npm run bench:search -- --count 1000
npm run bench:reopen -- --count 1000
npm run bench:compaction -- --count 1000
```

The scripts generate synthetic JSON documents, use temporary database directories by default, and print elapsed time in English. Pass `--keep` to keep the generated database directory for inspection.

Benchmark results depend on hardware, filesystem behavior, Node.js version, durability mode, and active operating system caches. The current milestone prioritizes correctness-first storage behavior over benchmark-driven optimization.

## Current Limitations

This release includes manual compaction and WAL generation checkpointing. Automatic background compaction, advanced compaction selection, optimized posting encodings, and advanced scope-aware array `elemMatch` semantics remain future work.

## Future Roadmap

- Automatic compaction scheduling and richer compaction selection.
- More compact posting encodings.
- Larger-scale lazy loading and cache controls.
- Richer scoped array matching.
- Richer storage diagnostics and recovery tooling.
