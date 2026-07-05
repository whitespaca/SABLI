import { rm } from "node:fs/promises";
import { SabliDatabase } from "sablidb";

const path = "./data/basic.sabli";
await rm(path, { recursive: true, force: true });

const db = await SabliDatabase.open({
  path,
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
