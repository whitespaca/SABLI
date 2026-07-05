# SABLI

![npm](https://img.shields.io/npm/v/@whitespaca/sabli) ![npm](https://img.shields.io/npm/dt/@whitespaca/sabli)

SABLI is an ESModule-only TypeScript library for indexing and searching unordered schema-less JSON documents. SABLI stands for Segmented Adaptive Bloom-LSM Inverted Index.

This initial package provides a correctness-first in-memory mutable segment with path-value extraction, advisory Bloom pruning, adaptive posting abstractions, and exact final verification.

## Installation

```bash
npm install @whitespaca/sabli
```

SABLI targets Node.js 22 or later and is published as ESModule only.

## Basic Usage

```ts
import { SabliEngine } from "@whitespaca/sabli";

const engine = new SabliEngine();

await engine.insert({
  user: { name: "Kim", age: 31 },
  tags: ["backend", "typescript"]
});

const results = await engine.search({
  where: {
    and: [
      { path: "user.name", eq: "Kim" },
      { path: "tags[]", contains: "backend" }
    ]
  }
});

console.log(results.documents);
```

## Query Examples

Field-map syntax:

```ts
await engine.search({
  where: {
    "user.name": { eq: "Kim" },
    "tags[]": { contains: "typescript" }
  }
});
```

Explicit Boolean syntax:

```ts
await engine.search({
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

## Correctness Model

Indexes and Bloom filters only generate candidate documents. SABLI verifies every candidate against the raw JSON document before returning it, so final search results follow exact query semantics.

## Current Limitations

This release is an in-memory correctness foundation. Persistent segments, WAL recovery, compaction, optimized posting encodings, and advanced scope-aware array `elemMatch` semantics are planned future work.
