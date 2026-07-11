/** Observable automatic-maintenance lifecycle state. */
export type MaintenanceState = "idle" | "scheduled" | "running" | "closing" | "failed";

/** Result of one bounded automatic maintenance evaluation. */
export interface MaintenanceRunResult {
  readonly compacted: boolean;
  readonly reason?: string;
  readonly inputSegmentCount?: number;
  readonly outputLevel?: number;
}

/** Immutable scheduler diagnostics copied into database statistics. */
export interface MaintenanceDiagnostics {
  readonly state: MaintenanceState;
  readonly activeInputSegmentCount: number;
  readonly activeOutputLevel: number | null;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly lastReason: string | null;
  readonly lastStartTime: string | null;
  readonly lastEndTime: string | null;
  readonly lastError: string | null;
}

/** Small single-job background maintenance scheduler. */
export class MaintenanceScheduler {
  readonly #enabled: boolean;
  readonly #intervalMs: number;
  readonly #run: () => Promise<MaintenanceRunResult>;
  #state: MaintenanceState = "idle";
  #timer: NodeJS.Timeout | undefined;
  #active: Promise<MaintenanceRunResult> | undefined;
  #closing = false;
  #completedCount = 0;
  #failedCount = 0;
  #activeInputSegmentCount = 0;
  #activeOutputLevel: number | null = null;
  #lastReason: string | null = null;
  #lastStartTime: string | null = null;
  #lastEndTime: string | null = null;
  #lastError: string | null = null;

  public constructor(enabled: boolean, intervalMs: number, run: () => Promise<MaintenanceRunResult>) {
    this.#enabled = enabled;
    this.#intervalMs = intervalMs;
    this.#run = run;
  }

  /** Starts the bounded periodic check loop when enabled. */
  public start(): void {
    if (this.#enabled) {
      this.schedule();
    }
  }

  /** Requests a future policy evaluation without overlapping existing work. */
  public notify(): void {
    if (this.#enabled && !this.#closing && this.#state !== "running") {
      this.schedule();
    }
  }

  /** Records the currently executing plan for low-cost diagnostics. */
  public reportActivePlan(inputSegmentCount: number, outputLevel: number, reason: string): void {
    this.#activeInputSegmentCount = inputSegmentCount;
    this.#activeOutputLevel = outputLevel;
    this.#lastReason = reason;
  }

  /** Runs scheduled maintenance promptly and drains currently eligible jobs. */
  public async waitForMaintenance(): Promise<void> {
    if (!this.#enabled || this.#closing) {
      try {
        await this.#active;
      } catch {
        // The active scheduler invocation records the failure.
      }
      return;
    }
    this.clearTimer();
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const result = await this.runOne();
      if (!result.compacted) {
        break;
      }
    }
    if (this.#state !== "failed") {
      this.schedule();
    }
  }

  /** Stops future checks and waits for the active job to reach a terminal state. */
  public async close(): Promise<void> {
    this.#closing = true;
    this.clearTimer();
    this.#state = "closing";
    try {
      await this.#active;
    } catch {
      // The owning runOne() call records the failure deterministically.
    }
  }

  /** Returns a defensive read-only diagnostics snapshot. */
  public diagnostics(): MaintenanceDiagnostics {
    return Object.freeze({
      state: this.#state,
      activeInputSegmentCount: this.#activeInputSegmentCount,
      activeOutputLevel: this.#activeOutputLevel,
      completedCount: this.#completedCount,
      failedCount: this.#failedCount,
      lastReason: this.#lastReason,
      lastStartTime: this.#lastStartTime,
      lastEndTime: this.#lastEndTime,
      lastError: this.#lastError
    });
  }

  private schedule(): void {
    if (this.#closing || this.#timer !== undefined || this.#active !== undefined) {
      return;
    }
    this.#state = "scheduled";
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runOne().then(() => {
        if (!this.#closing && this.#state !== "failed") {
          this.schedule();
        }
      });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  private async runOne(): Promise<MaintenanceRunResult> {
    if (this.#active !== undefined) {
      try {
        return await this.#active;
      } catch {
        return { compacted: false };
      }
    }
    this.#state = "running";
    this.#lastStartTime = new Date().toISOString();
    const active = this.#run();
    this.#active = active;
    try {
      const result = await active;
      this.#activeInputSegmentCount = result.inputSegmentCount ?? 0;
      this.#activeOutputLevel = result.outputLevel ?? null;
      if (result.compacted) {
        this.#completedCount += 1;
        this.#lastReason = result.reason ?? null;
      }
      this.#lastError = null;
      this.#state = this.#closing ? "closing" : "idle";
      return result;
    } catch (error) {
      this.#failedCount += 1;
      this.#lastError = error instanceof Error ? error.message : "Unknown automatic maintenance failure.";
      this.#state = this.#closing ? "closing" : "failed";
      return { compacted: false };
    } finally {
      this.#lastEndTime = new Date().toISOString();
      this.#activeInputSegmentCount = 0;
      this.#activeOutputLevel = null;
      this.#active = undefined;
    }
  }

  private clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
