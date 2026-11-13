import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { ReviewDialog } from '@renderer/components/team/dialogs/ReviewDialog';
import { TeamReviewActionError } from '@renderer/components/team/TeamReviewActionError';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import {
  acquireTaskAction,
  isTaskActionInFlight,
  publishTaskActionError,
  subscribeTaskActionEvents,
} from '@renderer/store/team/taskActionInFlight';
import { mapReviewError } from '@renderer/store/team/teamErrorPolicies';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import type { TaskRef } from '@shared/types';

interface GraphTaskActionHandlers {
  onApproveTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
}

interface UseGraphTaskActionsResult extends GraphTaskActionHandlers {
  dialog: React.ReactNode;
  taskActionHandlers: GraphTaskActionHandlers;
}

function isTaskContextCurrent(contextId: string): boolean {
  const state = useStore.getState();
  return !state.isContextSwitching && state.activeContextId === contextId;
}

export function useGraphTaskActions(teamName: string): UseGraphTaskActionsResult {
  const { t } = useAppTranslation('common');
  const [requestChangesTaskId, setRequestChangesTaskId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<
    { contextId: string; teamName: string; taskId: string; message: string }[]
  >([]);
  const {
    contextId,
    teamData,
    members,
    requestReview,
    sendTeamMessage,
    softDeleteTask,
    startTaskByUser,
    updateKanban,
    updateTaskStatus,
  } = useStore(
    useShallow((state) => ({
      contextId: state.activeContextId,
      teamData: selectTeamDataForName(state, teamName),
      members: selectResolvedMembersForTeamName(state, teamName),
      requestReview: state.requestReview,
      sendTeamMessage: state.sendTeamMessage,
      softDeleteTask: state.softDeleteTask,
      startTaskByUser: state.startTaskByUser,
      updateKanban: state.updateKanban,
      updateTaskStatus: state.updateTaskStatus,
    }))
  );

  useEffect(() => {
    setActionErrors([]);
    return subscribeTaskActionEvents((event) => {
      if (event.contextId !== contextId || event.teamName !== teamName) return;
      setActionErrors((errors) => {
        const remaining = errors.filter((error) => error.taskId !== event.taskId);
        return event.type === 'failed' ? [...remaining, event] : remaining;
      });
    });
  }, [contextId, teamName]);

  const runTaskAction = useCallback(
    (taskId: string, action: () => Promise<void>): void => {
      if (!isTaskContextCurrent(contextId)) return;
      const identity = { contextId, teamName, taskId };
      const release = acquireTaskAction(identity);
      if (!release) return;
      if (!isTaskContextCurrent(contextId)) {
        release();
        return;
      }
      const handleError = (error: unknown): void => {
        release();
        publishTaskActionError({ ...identity, message: mapReviewError(error) });
      };
      const run = async (): Promise<void> => {
        try {
          await action();
          release();
        } catch (error) {
          handleError(error);
        }
      };
      void run();
    },
    [contextId, teamName]
  );

  const onStartTask = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, async () => {
        const result = await startTaskByUser(teamName, taskId);
        if (!isTaskContextCurrent(contextId) || !teamData?.isAlive) return;

        const task = teamData.tasks.find((candidate) => candidate.id === taskId);
        try {
          if (result.notifiedOwner && task?.owner) {
            await api.teams.processSend(
              teamName,
              `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has started. Please begin working on it.`
            );
            return;
          }

          if (!result.notifiedOwner) {
            const desc = task?.description?.trim()
              ? `\nDescription: ${task.description.trim()}`
              : '';
            await api.teams.processSend(
              teamName,
              `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been moved to IN PROGRESS but has no assignee.${desc}\nPlease assign it to an available team member, or take it yourself if everyone is busy.`
            );
          }
        } catch {
          // best-effort notification
        }
      });
    },
    [contextId, runTaskAction, startTaskByUser, teamData, teamName]
  );

  const onCompleteTask = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, () => updateTaskStatus(teamName, taskId, 'completed'));
    },
    [runTaskAction, teamName, updateTaskStatus]
  );

  const onApproveTask = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, () =>
        updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' })
      );
    },
    [runTaskAction, teamName, updateKanban]
  );

  const onRequestReview = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, () => requestReview(teamName, taskId));
    },
    [requestReview, runTaskAction, teamName]
  );

  const onRequestChanges = useCallback(
    (taskId: string): void => {
      if (!isTaskContextCurrent(contextId) || isTaskActionInFlight({ contextId, teamName, taskId }))
        return;
      setRequestChangesTaskId(taskId);
    },
    [contextId, teamName]
  );

  const onCancelTask = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, async () => {
        const task = teamData?.tasks.find((candidate) => candidate.id === taskId);
        await updateTaskStatus(teamName, taskId, 'pending');
        if (!isTaskContextCurrent(contextId)) return;

        if (task?.owner) {
          try {
            await sendTeamMessage(teamName, {
              member: task.owner,
              text: `Task ${formatTaskDisplayLabel(task)} "${task.subject}" has been CANCELLED by the user and moved back to TODO. Stop working on it immediately.`,
              summary: `Task ${formatTaskDisplayLabel(task)} cancelled`,
            });
          } catch {
            // best-effort notification
          }
        }

        if (isTaskContextCurrent(contextId) && teamData?.isAlive) {
          try {
            const ownerSuffix = task?.owner ? ` ${task.owner} has been notified to stop.` : '';
            await api.teams.processSend(
              teamName,
              `Task #${deriveTaskDisplayId(taskId)} "${task?.subject ?? ''}" has been cancelled and moved back to TODO.${ownerSuffix}`
            );
          } catch {
            // best-effort notification
          }
        }
      });
    },
    [contextId, runTaskAction, sendTeamMessage, teamData, teamName, updateTaskStatus]
  );

  const onMoveBackToDone = useCallback(
    (taskId: string): void => {
      runTaskAction(taskId, async () => {
        await updateKanban(teamName, taskId, { op: 'remove' });
        if (!isTaskContextCurrent(contextId)) return;
        await updateTaskStatus(teamName, taskId, 'completed');
      });
    },
    [contextId, runTaskAction, teamName, updateKanban, updateTaskStatus]
  );

  const onDeleteTask = useCallback(
    (taskId: string): void => {
      if (!isTaskContextCurrent(contextId) || isTaskActionInFlight({ contextId, teamName, taskId }))
        return;
      void (async () => {
        const confirmed = await confirm({
          title: 'Delete task',
          message: `Move task #${deriveTaskDisplayId(taskId)} to trash?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          variant: 'danger',
        });
        if (!confirmed) return;

        runTaskAction(taskId, () => softDeleteTask(teamName, taskId));
      })();
    },
    [contextId, runTaskAction, softDeleteTask, teamName]
  );

  const handleSubmitRequestChanges = useCallback(
    (comment?: string, taskRefs?: TaskRef[]): void => {
      if (!requestChangesTaskId) return;
      runTaskAction(requestChangesTaskId, async () => {
        await updateKanban(teamName, requestChangesTaskId, {
          op: 'request_changes',
          comment,
          taskRefs,
        });
        if (isTaskContextCurrent(contextId)) setRequestChangesTaskId(null);
      });
    },
    [contextId, requestChangesTaskId, runTaskAction, teamName, updateKanban]
  );

  const taskActionHandlers = useMemo<GraphTaskActionHandlers>(
    () => ({
      onApproveTask,
      onCancelTask,
      onCompleteTask,
      onDeleteTask,
      onMoveBackToDone,
      onRequestChanges,
      onRequestReview,
      onStartTask,
    }),
    [
      onApproveTask,
      onCancelTask,
      onCompleteTask,
      onDeleteTask,
      onMoveBackToDone,
      onRequestChanges,
      onRequestReview,
      onStartTask,
    ]
  );

  return {
    ...taskActionHandlers,
    taskActionHandlers,
    dialog: (
      <>
        <div className="absolute left-1/2 top-14 z-40 max-h-[50%] w-[min(28rem,100%)] -translate-x-1/2 overflow-y-auto empty:hidden">
          {actionErrors
            .filter((error) => error.contextId === contextId && error.teamName === teamName)
            .map((error) => {
              const task = teamData?.tasks.find((candidate) => candidate.id === error.taskId);
              return (
                <div key={error.taskId}>
                  <div className="mx-4 mb-1 flex items-center justify-between rounded-md bg-[var(--color-surface)] px-2 text-xs font-semibold text-[var(--color-text)]">
                    <span>
                      {teamName} · {formatTaskDisplayLabel(task ?? { id: error.taskId })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="size-7 p-0"
                      aria-label={t('actions.close')}
                      onClick={() =>
                        setActionErrors((errors) => errors.filter((item) => item !== error))
                      }
                    >
                      <X size={14} />
                    </Button>
                  </div>
                  <TeamReviewActionError error={error.message} />
                </div>
              );
            })}
        </div>
        <ReviewDialog
          open={requestChangesTaskId !== null}
          teamName={teamName}
          taskId={requestChangesTaskId}
          members={members}
          onCancel={() => setRequestChangesTaskId(null)}
          onSubmit={handleSubmitRequestChanges}
        />
      </>
    ),
  };
}
