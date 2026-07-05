# SABLI

[![npm version](https://img.shields.io/npm/v/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![npm downloads](https://img.shields.io/npm/dm/sablidb.svg)](https://www.npmjs.com/package/sablidb)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

SABLI is an ESModule-only TypeScript library for indexing and searching unordered schema-less JSON documents. SABLI stands for Segmented Adaptive Bloom-LSM Inverted Index.

This initial package provides a correctness-first embedded database with a memory write buffer, append-only WAL, immutable disk segments, advisory Bloom pruning, adaptive posting abstractions, and exact final verification.

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

All public inputs are validated at runtime with TypeSea-backed SABLI validation helpers. Validation failures are wrapped in SABLI error classes such as `SabliValidationError` and `SabliCorruptionError`.

Documents must be JSON-compatible plain objects. Values such as `undefined`, `Date`, `Map`, `Set`, functions, symbols, and bigint values must be serialized before insertion.

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

A SABLI database is a directory with a lock file, `CURRENT`, a versioned manifest, one append-only WAL file, and immutable segment directories:

```txt
database.sabli/
  LOCK
  CURRENT
  MANIFEST-000001
  WAL-000001.log
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

Inserts, deletes, and updates are appended to the WAL before they are acknowledged in strict durability mode. `flush()` writes the current memory segment to an immutable disk segment and updates the manifest atomically.

## Durability And Recovery

The default durability mode is `strict`, which asks Node.js to flush WAL appends before acknowledging writes. On startup, SABLI reads `CURRENT`, validates the active manifest, opens immutable segments, loads delete bitmaps, and replays valid WAL records newer than the manifest checkpoint.

Partial trailing WAL records are handled deterministically by stopping at the last valid record. Checksum mismatches are treated as controlled recovery errors.

## Current Limitations

This release is a persistent correctness foundation. Compaction is still future work, so deleted and superseded versions may remain on disk until a later compaction milestone. Optimized posting encodings, richer delete bitmap management, and advanced scope-aware array `elemMatch` semantics are also planned future work.

## Future Roadmap

- Segment compaction and obsolete-version cleanup.
- More compact posting encodings.
- Larger-scale lazy loading and cache controls.
- Richer scoped array matching.
- Additional storage diagnostics and recovery tooling.
