/** Pure admission rules for canonical team task writes; no persistence or transport. */
import {
  localIdFromRef,
  normalizeLocalId,
  REGISTRY_TO_TEAM_STATUS,
  registryTaskId,
} from './RegistryTaskIdentity';
import { RegistryTeamTaskWriteError } from './RegistryTeamTaskWriteErrors';

import type { RegistryTask } from './RegistryTaskClientTypes';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { TeamTaskStatus } from '@shared/types';

export function resolveRegistryTaskLocalId(
  binding: TeamSpecBinding,
  taskId: string,
  tasks: readonly RegistryTask[]
): string {
  const key = taskId.trim();
  const byIdentity = tasks.find(
    (candidate) => registryTaskId({ ...binding, localId: candidate.localId }) === key
  );
  if (byIdentity) return normalizeLocalId(byIdentity.localId) ?? byIdentity.localId;
  const localId = key.includes(':') ? localIdFromRef(binding.spec, key) : normalizeLocalId(key);
  if (localId !== null && tasks.some((task) => normalizeLocalId(task.localId) === localId)) {
    return localId;
  }
  throw new RegistryTeamTaskWriteError(
    'TASK_NOT_FOUND',
    `"${taskId}" is not a task id of ${binding.project}/${binding.spec}`,
    { taskId }
  );
}

export function requireRegistryTaskLocalId(taskId: string): string {
  const localId = normalizeLocalId(taskId);
  if (localId === null) {
    throw new RegistryTeamTaskWriteError('TASK_NOT_FOUND', `"${taskId}" is not a task id`, {
      taskId,
    });
  }
  return localId;
}

/** Walks the target's dependency chain; a reachable source means the write would close a cycle. */
export function assertNoRegistryTaskDependencyCycle(
  binding: TeamSpecBinding,
  tasks: readonly RegistryTask[],
  sourceLocalId: string,
  targetRef: string
): void {
  const byLocalId = new Map<string, RegistryTask>();
  for (const task of tasks) {
    const parsed = normalizeLocalId(task.localId);
    if (parsed !== null) byLocalId.set(parsed, task);
  }
  const visited = new Set<string>();
  const stack = [localIdFromRef(binding.spec, targetRef)].filter(
    (value): value is string => value !== null
  );
  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === sourceLocalId) {
      throw new RegistryTeamTaskWriteError(
        'LINK_CYCLE',
        `Circular dependency: #${targetRef} already depends on #${sourceLocalId}`,
        { taskId: sourceLocalId }
      );
    }
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const task = byLocalId.get(currentId);
    if (!task) continue;
    for (const ref of task.dependsOn) {
      const dependency = localIdFromRef(binding.spec, ref);
      if (dependency !== null) stack.push(dependency);
    }
  }
}

/** Refuse stale/deleted status transitions before any registry or execution write. */
export function isRegistryTaskStatusUnchanged(
  current: RegistryTask,
  input: { to: TeamTaskStatus; expectedStatus?: TeamTaskStatus },
  localId: string
): boolean {
  if (
    input.expectedStatus !== undefined &&
    REGISTRY_TO_TEAM_STATUS[current.status] !== input.expectedStatus
  ) {
    throw new RegistryTeamTaskWriteError(
      'STATUS_CONFLICT',
      `Task #${localId} has changed status. Re-read the task and retry.`,
      {
        taskId: localId,
        details: {
          currentStatus: REGISTRY_TO_TEAM_STATUS[current.status],
          expectedStatus: input.expectedStatus,
        },
      }
    );
  }
  if (
    current.status === 'deleted' &&
    input.to !== 'deleted' &&
    input.expectedStatus !== 'deleted'
  ) {
    throw new RegistryTeamTaskWriteError(
      'STATUS_CONFLICT',
      `Task #${localId} is deleted; restore it before changing status.`,
      {
        taskId: localId,
        details: { currentStatus: 'deleted', expectedStatus: input.expectedStatus },
      }
    );
  }
  return REGISTRY_TO_TEAM_STATUS[current.status] === input.to;
}

/** Review admission runs before the canonical verdict and local history are changed. */
export function admitRegistryTaskReview(
  canonical: RegistryTask,
  input: { action: 'request' | 'approve' | 'changes' | 'clear'; manual?: boolean },
  from: string,
  localId: string
): { unchanged: boolean; alreadyApproved: boolean } {
  if (input.action === 'clear') {
    if (from !== 'none')
      throw new Error(
        `Task #${localId} is in reviewState=${from}; use review or status transitions instead`
      );
    return { unchanged: true, alreadyApproved: false };
  }
  if (input.action === 'request' && canonical.status !== 'done') {
    throw new Error(`Task #${localId} must be completed before review`);
  }
  if (input.action === 'request' && from === 'approved') {
    throw new Error(`Task #${localId} is already approved`);
  }
  // Repeating an approval is a no-op locally, but the canonical verdict is
  // still re-sent: a previous run may have failed after the local write.
  const alreadyApproved = input.action === 'approve' && from === 'approved';
  if (
    !alreadyApproved &&
    input.action !== 'request' &&
    from !== 'review' &&
    !(input.action === 'approve' && input.manual && canonical.status === 'done')
  ) {
    throw new Error(`Task #${localId} must be in review before this action`);
  }
  return { unchanged: false, alreadyApproved };
}
