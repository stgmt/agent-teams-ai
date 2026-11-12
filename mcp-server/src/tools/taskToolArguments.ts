const DEFAULT_TASK_LIST_LIMIT = 50;
const MAX_TASK_LIST_LIMIT = 200;

export function resolveTaskScope(project?: string, spec?: string) {
  if (project === undefined && spec === undefined) return undefined;
  if (project === undefined || spec === undefined) {
    throw new Error('Task scope requires both project and spec');
  }
  return { project, spec };
}

export function normalizeTaskListLimit(limit: number | undefined): number {
  if (limit == null) {
    return DEFAULT_TASK_LIST_LIMIT;
  }
  return Math.min(Math.max(1, Math.floor(limit)), MAX_TASK_LIST_LIMIT);
}
