import type { KanbanTaskState, TeamTask, TeamTaskWithKanban } from '@shared/types';

const taskCardSignatureCache = new WeakMap<TeamTaskWithKanban, string>();

export function getTaskCardSignature(task: TeamTaskWithKanban): string {
  const cached = taskCardSignatureCache.get(task);
  if (cached !== undefined) return cached;

  const signature = JSON.stringify(task);
  taskCardSignatureCache.set(task, signature);
  return signature;
}

export function areKanbanTaskStatesEqual(
  prev: KanbanTaskState | undefined,
  next: KanbanTaskState | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  return (
    prev.column === next.column &&
    prev.reviewer === next.reviewer &&
    prev.errorDescription === next.errorDescription &&
    prev.movedAt === next.movedAt
  );
}

function getTaskDependencyIds(task: TeamTaskWithKanban): string[] {
  return [...(task.blockedBy ?? []), ...(task.blocks ?? [])].filter((id) => id.length > 0);
}

function getDependencyTaskSignature(task: TeamTask | undefined): string {
  if (!task) return '';
  const kanbanTask = task as Partial<TeamTaskWithKanban>;
  return [
    task.id,
    task.displayId ?? '',
    task.subject,
    task.status,
    task.reviewState ?? '',
    kanbanTask.kanbanColumn ?? '',
  ].join('\u001f');
}

export function areTaskMapDependenciesEqual(
  prevTask: TeamTaskWithKanban,
  nextTask: TeamTaskWithKanban,
  prevTaskMap: Map<string, TeamTask>,
  nextTaskMap: Map<string, TeamTask>
): boolean {
  const dependencyIds = new Set([
    ...getTaskDependencyIds(prevTask),
    ...getTaskDependencyIds(nextTask),
  ]);
  for (const taskId of dependencyIds) {
    if (
      getDependencyTaskSignature(prevTaskMap.get(taskId)) !==
      getDependencyTaskSignature(nextTaskMap.get(taskId))
    ) {
      return false;
    }
  }
  return true;
}
