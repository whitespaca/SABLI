import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { SabliStorageError } from "../errors/index.js";

/**
 * Atomically replaces a file by writing a temporary file in the same directory and renaming it.
 *
 * @param path - Destination file path.
 * @param data - File contents.
 * @throws {SabliStorageError} If the write or rename fails.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new SabliStorageError(`Failed to atomically replace file ${path}.`, { cause: error });
  }
}
