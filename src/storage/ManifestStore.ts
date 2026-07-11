import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SegmentId } from "../types/json.js";
import { toDocId, toSegmentId, type DocId } from "../types/json.js";
import { writeFileAtomic } from "./AtomicFile.js";
import { checksum, stableJson } from "./Checksum.js";
import { SabliCorruptionError } from "../errors/index.js";
import { DatabaseManifestInputGuard } from "../validation/schemas.js";
import { assertValid } from "../validation/assertValid.js";

/**
 * Segment entry recorded in the database manifest.
 */
export interface ManifestSegmentEntry {
  /** Segment identifier. */
  readonly segmentId: SegmentId;
  /** Segment directory relative path. */
  readonly path: string;
  /** Number of documents in the segment. */
  readonly docCount: number;
}

/**
 * Versioned database manifest persisted under MANIFEST files.
 */
export interface DatabaseManifest {
  /** Manifest format marker. */
  readonly format: "sabli-manifest";
  /** Manifest format version. */
  readonly version: 1;
  /** Next document identifier to assign. */
  readonly nextDocId: DocId;
  /** Next immutable segment identifier to assign. */
  readonly nextSegmentId: SegmentId;
  /** Live immutable segment list. */
  readonly segments: readonly ManifestSegmentEntry[];
  /** Last WAL sequence included in durable immutable segments. */
  readonly flushedWalSequence: number;
  /** Active WAL generation for new writes. */
  readonly activeWalGeneration: number;
  /** Checksum over the manifest payload. */
  readonly checksum: string;
}

/**
 * Persists and loads database manifests through CURRENT.
 */
export class ManifestStore {
  readonly #root: string;
  readonly #currentPath: string;
  #activeGeneration = 0;

  /**
   * Creates a manifest store.
   *
   * @param root - Database root directory.
   * @param currentPath - CURRENT file path.
   */
  public constructor(root: string, currentPath: string) {
    this.#root = root;
    this.#currentPath = currentPath;
  }

  /**
   * Creates an empty manifest.
   *
   * @returns Initial manifest.
   */
  public createInitial(): DatabaseManifest {
    return this.withChecksum({
      format: "sabli-manifest",
      version: 1,
      nextDocId: toDocId(1),
      nextSegmentId: toSegmentId(1),
      segments: [],
      flushedWalSequence: 0,
      activeWalGeneration: 1
    });
  }

  /**
   * Reads the active manifest.
   *
   * @returns Validated manifest.
   * @throws {SabliCorruptionError} If CURRENT or the manifest is malformed.
   */
  public async read(): Promise<DatabaseManifest> {
    let current: string;
    try {
      current = (await readFile(this.#currentPath, "utf8")).trim();
    } catch (error) {
      throw new SabliCorruptionError("Invalid CURRENT file: the active manifest pointer is missing or unreadable.", { cause: error });
    }
    const generation = parseManifestGeneration(current);
    if (generation === undefined) {
      throw new SabliCorruptionError("Invalid CURRENT file: expected a manifest file name.");
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#root, current), "utf8");
    } catch (error) {
      throw new SabliCorruptionError(`Invalid CURRENT file: active manifest ${current} is missing or unreadable.`, { cause: error });
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const manifest = parseDatabaseManifest(parsed);
      this.#activeGeneration = generation;
      return manifest;
    } catch (error) {
      if (error instanceof SabliCorruptionError) {
        throw error;
      }
      throw new SabliCorruptionError(`Invalid active manifest ${current}: expected valid JSON.`, { cause: error });
    }
  }

  /**
   * Writes a manifest and updates CURRENT atomically enough for the JSON metadata format.
   *
   * @param manifest - Manifest to persist.
   */
  public async write(
    manifest: DatabaseManifest,
    hooks: { readonly afterGenerationWrite?: () => Promise<void> } = {}
  ): Promise<DatabaseManifest> {
    const persisted = this.withChecksum(manifest);
    const generation = await this.nextAvailableGeneration();
    const name = formatManifestName(generation);
    await writeFileAtomic(join(this.#root, name), `${JSON.stringify(persisted, null, 2)}\n`);
    await hooks.afterGenerationWrite?.();
    await writeFileAtomic(this.#currentPath, `${name}\n`);
    this.#activeGeneration = generation;
    return persisted;
  }

  /** Active manifest filename generation, or zero before the first read/write. */
  public get activeGeneration(): number {
    return this.#activeGeneration;
  }

  private async nextAvailableGeneration(): Promise<number> {
    let generation = this.#activeGeneration + 1;
    while (await fileExists(join(this.#root, formatManifestName(generation)))) {
      generation += 1;
    }
    return generation;
  }

  private withChecksum(input: Omit<DatabaseManifest, "checksum"> | DatabaseManifest): DatabaseManifest {
    const payload = {
      format: input.format,
      version: input.version,
      nextDocId: input.nextDocId,
      nextSegmentId: input.nextSegmentId,
      segments: input.segments,
      flushedWalSequence: input.flushedWalSequence,
      activeWalGeneration: input.activeWalGeneration
    };
    return { ...payload, checksum: checksum(stableJson(payload)) };
  }
}

function formatManifestName(generation: number): string {
  return `MANIFEST-${String(generation).padStart(6, "0")}`;
}

function parseManifestGeneration(name: string): number | undefined {
  const match = /^MANIFEST-(\d{6,})$/.exec(name);
  if (match === null) {
    return undefined;
  }
  const generation = Number(match[1]);
  return Number.isSafeInteger(generation) && generation >= 1 ? generation : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates and narrows unknown persisted database manifest data.
 *
 * @param input - Unknown manifest payload.
 * @returns Validated database manifest.
 * @throws {SabliCorruptionError} If the manifest is malformed.
 */
export function parseDatabaseManifest(input: unknown): DatabaseManifest {
  const record = assertValid(DatabaseManifestInputGuard, input, "corruption", "Invalid manifest.");
  const activeWalGeneration = record.activeWalGeneration ?? 1;
  const segments = record.segments.map((segment): ManifestSegmentEntry => ({
    segmentId: toSegmentId(segment.segmentId),
    path: segment.path,
    docCount: segment.docCount
  }));
  const payload = {
    format: record.format,
    version: record.version,
    nextDocId: record.nextDocId,
    nextSegmentId: record.nextSegmentId,
    segments: record.segments,
    flushedWalSequence: record.flushedWalSequence,
    activeWalGeneration
  };
  const legacyPayload = {
    format: record.format,
    version: record.version,
    nextDocId: record.nextDocId,
    nextSegmentId: record.nextSegmentId,
    segments: record.segments,
    flushedWalSequence: record.flushedWalSequence
  };
  const expectedChecksum = record.activeWalGeneration === undefined ? checksum(stableJson(legacyPayload)) : checksum(stableJson(payload));
  if (expectedChecksum !== record.checksum) {
    throw new SabliCorruptionError("Invalid manifest: checksum mismatch.");
  }
  return {
    format: "sabli-manifest",
    version: 1,
    nextDocId: toDocId(record.nextDocId),
    nextSegmentId: toSegmentId(record.nextSegmentId),
    flushedWalSequence: record.flushedWalSequence,
    activeWalGeneration,
    segments,
    checksum: record.checksum
  };
}
