export interface ActivityIntervalResult {
  changedTasks: number;
  failed?: boolean;
  pendingTransition?: boolean;
}

/** Do not change a task whose review transition has an unresolved outcome. */
export function skipPendingActivity<T extends object>(
  task: T,
  mutate: (candidate: T) => boolean,
  state: { blocked: boolean }
): boolean {
  if (!('pendingKanbanTransition' in task)) return false;
  // Mutators modify arrays in place. Probe a copy so neither the persisted task
  // nor the activity cache can change the evidence needed for recovery.
  if (!state.blocked && mutate(structuredClone(task))) state.blocked = true;
  return true;
}
