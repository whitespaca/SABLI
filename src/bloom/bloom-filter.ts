import { SabliCorruptionError, SabliValidationError } from "../errors/index.js";
import type { BloomOptions } from "../query/ast.js";
import { SerializedBloomFilterGuard } from "../validation/schemas.js";
import { hashString } from "./hash.js";

/**
 * Serialized Bloom filter data.
 */
export interface SerializedBloomFilter {
  /** Serialization format identifier. */
  readonly format: "sabli-bloom";
  /** Serialization version. */
  readonly version: 1;
  /** Number of bits in the filter. */
  readonly bitSize: number;
  /** Number of hash functions. */
  readonly hashCount: number;
  /** Base64 encoded bitset. */
  readonly data: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(input: string): Uint8Array {
  return Uint8Array.from(Buffer.from(input, "base64"));
}

/**
 * Deterministic Bloom filter used for advisory negative pruning.
 */
export class BloomFilter {
  readonly #bitSize: number;
  readonly #hashCount: number;
  readonly #bytes: Uint8Array;

  /**
   * Creates a Bloom filter from validated options.
   *
   * @param options - Bloom filter options.
   * @throws {SabliValidationError} If the options are impossible.
   */
  public constructor(options: BloomOptions);
  public constructor(bitSize: number, hashCount: number, bytes: Uint8Array);
  public constructor(optionsOrBitSize: BloomOptions | number, hashCount?: number, bytes?: Uint8Array) {
    if (typeof optionsOrBitSize === "number") {
      if (hashCount === undefined || bytes === undefined) {
        throw new SabliCorruptionError("Invalid Bloom filter data: missing internal constructor values.");
      }
      this.#bitSize = optionsOrBitSize;
      this.#hashCount = hashCount;
      this.#bytes = bytes;
      return;
    }
    const options = optionsOrBitSize;
    if (options.expectedEntries < 1 || options.falsePositiveRate <= 0 || options.falsePositiveRate >= 1) {
      throw new SabliValidationError("Invalid Bloom options: expectedEntries must be at least 1 and falsePositiveRate must be between 0 and 1.");
    }
    const bitSize = Math.max(8, Math.ceil((-options.expectedEntries * Math.log(options.falsePositiveRate)) / Math.LN2 ** 2));
    this.#bitSize = bitSize;
    this.#hashCount = Math.max(1, Math.ceil((bitSize / options.expectedEntries) * Math.LN2));
    this.#bytes = new Uint8Array(Math.ceil(bitSize / 8));
  }

  /**
   * Adds a key to the filter.
   *
   * @param key - String key to add.
   */
  public add(key: string): void {
    for (const index of this.indexes(key)) {
      const byteIndex = Math.floor(index / 8);
      const byte = this.#bytes[byteIndex];
      if (byte === undefined) {
        throw new SabliCorruptionError("Invalid Bloom filter state: hash index is out of bounds.");
      }
      this.#bytes[byteIndex] = byte | (1 << (index % 8));
    }
  }

  /**
   * Tests whether a key may have been added.
   *
   * @param key - String key to test.
   * @returns False only when the key is definitely absent.
   */
  public mightContain(key: string): boolean {
    for (const index of this.indexes(key)) {
      const byte = this.#bytes[Math.floor(index / 8)];
      if (byte === undefined || (byte & (1 << (index % 8))) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Serializes the Bloom filter into a versioned JSON-compatible object.
   *
   * @returns Serialized Bloom filter data.
   */
  public serialize(): SerializedBloomFilter {
    return {
      format: "sabli-bloom",
      version: 1,
      bitSize: this.#bitSize,
      hashCount: this.#hashCount,
      data: toBase64(this.#bytes)
    };
  }

  /**
   * Deserializes a Bloom filter from a versioned object.
   *
   * @param input - Serialized Bloom filter data.
   * @returns Deserialized Bloom filter.
   * @throws {SabliCorruptionError} If the serialized data is malformed.
   */
  public static deserialize(input: unknown): BloomFilter {
    const result = SerializedBloomFilterGuard.check(input);
    if (!result.ok) {
      throw new SabliCorruptionError("Invalid Bloom filter data: unsupported or malformed metadata.");
    }
    const data = result.value;
    return new BloomFilter(data.bitSize, data.hashCount, fromBase64(data.data));
  }

  private *indexes(key: string): Iterable<number> {
    const left = hashString(key, 0);
    const right = hashString(key, 0x9e3779b9) || 1;
    for (let index = 0; index < this.#hashCount; index += 1) {
      yield ((left + Math.imul(index, right)) >>> 0) % this.#bitSize;
    }
  }
}
