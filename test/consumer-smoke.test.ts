import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SabliDatabase } from "sablidb";

const roots: string[] = [];

async function tempDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sablidb-consumer-"));
  roots.push(root);
  return join(root, "database.sabli");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("consumer package entrypoint", () => {
  it("opens, inserts, searches, and closes through the published entrypoint", async () => {
    const db = await SabliDatabase.open({
      path: await tempDbPath(),
      createIfMissing: true
    });

    await db.insert({
      user: { name: "Kim", age: 31 },
      tags: ["backend", "typescript"]
    });

    const equality = await db.search({
      where: { "user.name": { eq: "Kim" } }
    });
    expect(equality.count).toBe(1);

    const contains = await db.search({
      where: { "tags[]": { contains: "backend" } }
    });
    expect(contains.count).toBe(1);

    await db.close();
  });
});
