export interface TaskActionIdentity {
  contextId: string;
  teamName: string;
  taskId: string;
}

export interface TaskActionError extends TaskActionIdentity {
  message: string;
}

export type TaskActionEvent =
  | ({ type: 'started' } & TaskActionIdentity)
  | ({ type: 'failed' } & TaskActionError);

const pendingActions = new Map<string, symbol>();
const actionListeners = new Set<(event: TaskActionEvent) => void>();

function actionKey({ contextId, teamName, taskId }: TaskActionIdentity): string {
  return JSON.stringify([contextId, teamName, taskId]);
}

export function isTaskActionInFlight(identity: TaskActionIdentity): boolean {
  return pendingActions.has(actionKey(identity));
}

export function acquireTaskAction(identity: TaskActionIdentity): (() => void) | null {
  const key = actionKey(identity);
  if (pendingActions.has(key)) return null;
  const token = Symbol();
  pendingActions.set(key, token);
  for (const listener of actionListeners) listener({ type: 'started', ...identity });
  return () => {
    if (pendingActions.get(key) === token) pendingActions.delete(key);
  };
}

export function subscribeTaskActionEvents(listener: (event: TaskActionEvent) => void): () => void {
  actionListeners.add(listener);
  return () => {
    actionListeners.delete(listener);
  };
}

export function publishTaskActionError(error: TaskActionError): void {
  for (const listener of actionListeners) listener({ type: 'failed', ...error });
}
