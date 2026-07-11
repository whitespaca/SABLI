/**
 * Small FIFO async mutex used to serialize database state mutations.
 */
export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /**
   * Runs one operation after all previously submitted operations finish.
   *
   * @param operation - Exclusive asynchronous operation.
   * @returns The operation result.
   */
  public async runExclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    let release: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
