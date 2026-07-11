/**
 * Runtime lifecycle state for a SABLI database handle.
 */
export type DatabaseLifecycleState = "open" | "closing" | "closed";

/**
 * Checks whether a lifecycle state accepts read or write operations.
 *
 * @param state - Current lifecycle state.
 * @returns True when the database is open.
 */
export function isDatabaseOpen(state: DatabaseLifecycleState): boolean {
  return state === "open";
}
