import { open, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { SabliCorruptionError } from "../errors/index.js";
import type { JsonObject } from "../types/json.js";
import { toDocId, type DocId } from "../types/json.js";
import { JsonObjectGuard } from "../validation/schemas.js";
import type { DocumentOffset, OffsetTableFile } from "./OffsetTable.js";

/**
 * Writes raw JSON documents into an append-only block file.
 */
export class DocumentBlockWriter {
  readonly #path: string;
  readonly #offsets: DocumentOffset[] = [];
  #position = 0;

  /**
   * Creates a document block writer.
   *
   * @param path - docs.bin path.
   */
  public constructor(path: string) {
    this.#path = path;
  }

  /**
   * Writes all documents to the block file.
   *
   * @param documents - Documents paired with identifiers.
   * @returns Offset table file contents.
   */
  public async writeAll(documents: readonly { readonly docId: DocId; readonly document: JsonObject }[]): Promise<OffsetTableFile> {
    const chunks: Uint8Array[] = [];
    for (const item of documents) {
      const encoded = new TextEncoder().encode(JSON.stringify(item.document));
      const bytes = Buffer.from(encoded);
      this.#offsets.push({ docId: item.docId, offset: this.#position, length: bytes.length });
      this.#position += bytes.length;
      chunks.push(bytes);
    }
    await writeFile(this.#path, Buffer.concat(chunks));
    return { format: "sabli-doc-offsets", version: 1, offsets: this.#offsets };
  }
}

/**
 * Reads raw JSON documents from a document block file by offset table.
 */
export class DocumentBlockReader {
  readonly #path: string;
  readonly #offsets = new Map<number, DocumentOffset>();
  #handle: FileHandle | undefined;

  /**
   * Creates a document block reader.
   *
   * @param path - docs.bin path.
   * @param table - Offset table contents.
   */
  public constructor(path: string, table: OffsetTableFile) {
    this.#path = path;
    for (const offset of table.offsets) {
      this.#offsets.set(offset.docId, offset);
    }
  }

  /**
   * Reads one document by identifier.
   *
   * @param docId - Document identifier.
   * @returns Parsed JSON document, or undefined when missing.
   */
  public async read(docId: DocId): Promise<JsonObject | undefined> {
    const offset = this.#offsets.get(docId);
    if (offset === undefined) {
      return undefined;
    }
    this.#handle ??= await open(this.#path, "r");
    const buffer = Buffer.alloc(offset.length);
    await this.#handle.read(buffer, 0, offset.length, offset.offset);
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    const result = JsonObjectGuard.check(parsed);
    if (!result.ok) {
      throw new SabliCorruptionError("Invalid document block: document payload must be a JSON object.");
    }
    return result.value;
  }

  /**
   * Reads all documents from the block file.
   *
   * @returns All documents paired with identifiers.
   */
  public async readAll(): Promise<readonly { readonly docId: DocId; readonly document: JsonObject }[]> {
    const out: { readonly docId: DocId; readonly document: JsonObject }[] = [];
    for (const offset of this.#offsets.values()) {
      const document = await this.read(toDocId(offset.docId));
      if (document !== undefined) {
        out.push({ docId: toDocId(offset.docId), document });
      }
    }
    return out;
  }

  /**
   * Closes the underlying file handle.
   */
  public async close(): Promise<void> {
    if (this.#handle !== undefined) {
      await this.#handle.close();
      this.#handle = undefined;
    }
  }
}
