import { useStore } from '@renderer/store';
import { acquireTaskAction, publishTaskActionError } from '@renderer/store/team/taskActionInFlight';
import { mapReviewError } from '@renderer/store/team/teamErrorPolicies';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

/** Keep one action per task in flight across Kanban, graph, and the organization inspector. */
export function runTeamTaskAction(
  teamName: string,
  taskId: string,
  action: (isCurrent: () => boolean) => Promise<void>
): void {
  const { activeContextId, isContextSwitching } = useStore.getState();
  if (isContextSwitching) return;
  const epoch = captureContextScopedRequestEpoch();
  const isCurrent = (): boolean => {
    const current = useStore.getState();
    return (
      !current.isContextSwitching &&
      current.activeContextId === activeContextId &&
      isContextScopedRequestEpochCurrent(epoch)
    );
  };
  const identity = { contextId: activeContextId, teamName, taskId };
  const release = acquireTaskAction(identity);
  if (!release) return;
  if (!isCurrent()) {
    release();
    return;
  }
  const failed = (error: unknown): void => {
    release();
    publishTaskActionError({ ...identity, message: mapReviewError(error) });
  };
  const run = async (): Promise<void> => {
    try {
      await action(isCurrent);
      release();
    } catch (error) {
      failed(error);
    }
  };
  void run();
}
