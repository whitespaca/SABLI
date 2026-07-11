import { rm } from "node:fs/promises";
import { SabliDatabase } from "sablidb";

const path = "./data/automatic-compaction.sabli";
await rm(path, { recursive: true, force: true });

const db = await SabliDatabase.open({
  path,
  createIfMissing: true,
  automaticCompaction: {
    enabled: true,
    maxLevelZeroSegments: 2,
    maxInputSegments: 2,
    checkIntervalMs: 5_000
  }
});

for (let batch = 0; batch < 4; batch += 1) {
  await db.insert({
    batch,
    status: "active",
    orders: [{ id: `order-${String(batch)}`, price: 10_000 + batch }]
  });
  await db.flush();
}

console.dir(await db.stats(), { depth: null });
await db.waitForMaintenance();
console.dir(await db.stats(), { depth: null });

const result = await db.search({ where: { path: "status", eq: "active" } });
console.dir(result.documents, { depth: null });

await db.close();
