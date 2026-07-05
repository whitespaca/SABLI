import { rm } from "node:fs/promises";
import { SabliDatabase } from "sablidb";

const path = "./data/persistent-reopen.sabli";
await rm(path, { recursive: true, force: true });

const first = await SabliDatabase.open({
  path,
  createIfMissing: true
});

await first.insert({
  user: { name: "Lee", age: 28 },
  tags: ["frontend", "typescript"]
});

await first.close();

const reopened = await SabliDatabase.open({
  path,
  createIfMissing: false
});

const results = await reopened.search({
  where: {
    "tags[]": { contains: "frontend" }
  }
});

console.dir(results.documents, { depth: null });

await reopened.close();
