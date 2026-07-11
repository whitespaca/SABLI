/** Internal deterministic compaction boundaries available to repository tests. */
export type CompactionFailurePoint =
  | "after-plan-selection"
  | "after-output-written"
  | "after-output-validation"
  | "before-manifest-write"
  | "after-manifest-generation-write"
  | "after-current-swap"
  | "before-obsolete-cleanup"
  | "during-obsolete-cleanup";

type CompactionFailureHook = (point: CompactionFailurePoint) => void | Promise<void>;

let activeHook: CompactionFailureHook | undefined;

/**
 * Installs one repository-test-only deterministic compaction failure hook.
 *
 * @param hook - Hook invoked at named safe boundaries.
 * @returns Function that restores the previous hook.
 * @internal
 */
export function setCompactionFailureHookForTests(hook: CompactionFailureHook | undefined): () => void {
  const previous = activeHook;
  activeHook = hook;
  return () => {
    activeHook = previous;
  };
}

/** Invokes the active test hook when one has been installed. @internal */
export async function triggerCompactionFailurePoint(point: CompactionFailurePoint): Promise<void> {
  await activeHook?.(point);
}
