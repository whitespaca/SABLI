import type { ImmutableSegment } from "../segment/ImmutableSegment.js";

/** Stable immutable-segment view held by one search operation. */
export interface SegmentSnapshotLease {
  readonly segments: readonly ImmutableSegment[];
  release(): Promise<void>;
}

interface SnapshotGeneration {
  readonly segments: readonly ImmutableSegment[];
  obsoleteAfterRelease: readonly ImmutableSegment[];
  activeReaders: number;
  retired: boolean;
  cleanupStarted: boolean;
  cleanupAllowed: boolean;
}

/**
 * Maintains stable search snapshots and delays obsolete-reader cleanup until
 * every lease on the retired generation has completed.
 */
export class SegmentSnapshotManager {
  #current: SnapshotGeneration;
  readonly #retired = new Set<SnapshotGeneration>();
  readonly #cleanup: (segments: readonly ImmutableSegment[]) => Promise<void>;
  readonly #cleanupError: (error: unknown) => void;
  readonly #readerWaiters = new Set<() => void>();

  public constructor(
    segments: readonly ImmutableSegment[],
    cleanup: (segments: readonly ImmutableSegment[]) => Promise<void>,
    cleanupError: (error: unknown) => void = () => undefined
  ) {
    this.#current = createGeneration(segments, []);
    this.#cleanup = cleanup;
    this.#cleanupError = cleanupError;
  }

  /** Current immutable segment array. */
  public get segments(): readonly ImmutableSegment[] {
    return this.#current.segments;
  }

  /** Number of obsolete segment readers waiting for a lease to finish. */
  public get pendingObsoleteSegmentCount(): number {
    return [...this.#retired].reduce((sum, generation) => sum + generation.obsoleteAfterRelease.length, 0);
  }

  /** Acquires one stable immutable-segment generation. */
  public acquire(): SegmentSnapshotLease {
    const generation = this.#current;
    generation.activeReaders += 1;
    let released = false;
    return {
      segments: generation.segments,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        generation.activeReaders -= 1;
        this.notifyReaderWaiters();
        await this.drain();
      }
    };
  }

  /** Publishes a new segment generation after its manifest is active. */
  public async replace(
    segments: readonly ImmutableSegment[],
    obsolete: readonly ImmutableSegment[],
    deferCleanup = false
  ): Promise<void> {
    const previous = this.#current;
    previous.retired = obsolete.length > 0;
    previous.obsoleteAfterRelease = Object.freeze([...obsolete]);
    previous.cleanupAllowed = !deferCleanup;
    this.#current = createGeneration(segments, []);
    if (obsolete.length > 0) {
      this.#retired.add(previous);
      await this.cleanupIfReady(previous);
    }
  }

  /** Allows cleanup for generations published with deferred reclamation. */
  public async allowCleanup(): Promise<void> {
    for (const generation of this.#retired) {
      generation.cleanupAllowed = true;
      await this.cleanupIfReady(generation);
    }
  }

  /** Waits for and cleans every retired generation that has no readers. */
  public async drain(): Promise<void> {
    const ready = [...this.#retired].filter(({ activeReaders }) => activeReaders === 0);
    await Promise.all(ready.map((generation) => this.cleanupIfReady(generation)));
  }

  /** Waits until all searches using current or retired generations finish. */
  public async waitForNoReaders(): Promise<void> {
    while (this.activeReaderCount() > 0) {
      await new Promise<void>((resolve) => {
        this.#readerWaiters.add(resolve);
      });
    }
  }

  private async cleanupIfReady(generation: SnapshotGeneration): Promise<void> {
    if (
      !generation.retired ||
      !generation.cleanupAllowed ||
      generation.activeReaders !== 0 ||
      generation.cleanupStarted ||
      this.hasActiveReaderReference(generation.obsoleteAfterRelease)
    ) {
      return;
    }
    generation.cleanupStarted = true;
    try {
      await this.#cleanup(generation.obsoleteAfterRelease);
      this.#retired.delete(generation);
    } catch (error) {
      generation.cleanupStarted = false;
      this.#cleanupError(error);
    }
  }

  private activeReaderCount(): number {
    return this.#current.activeReaders + [...this.#retired].reduce((sum, generation) => sum + generation.activeReaders, 0);
  }

  private hasActiveReaderReference(segments: readonly ImmutableSegment[]): boolean {
    const obsolete = new Set(segments);
    const generations = [this.#current, ...this.#retired];
    return generations.some((generation) =>
      generation.activeReaders > 0 && generation.segments.some((segment) => obsolete.has(segment))
    );
  }

  private notifyReaderWaiters(): void {
    if (this.activeReaderCount() !== 0) {
      return;
    }
    for (const resolve of this.#readerWaiters) {
      resolve();
    }
    this.#readerWaiters.clear();
  }
}

function createGeneration(
  segments: readonly ImmutableSegment[],
  obsoleteAfterRelease: readonly ImmutableSegment[]
): SnapshotGeneration {
  return {
    segments: Object.freeze([...segments]),
    obsoleteAfterRelease: Object.freeze([...obsoleteAfterRelease]),
    activeReaders: 0,
    retired: false,
    cleanupStarted: false,
    cleanupAllowed: true
  };
}
