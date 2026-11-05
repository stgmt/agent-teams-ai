import { useCallback, useEffect, useMemo, useState } from 'react';

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
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { useShallow } from 'zustand/react/shallow';

import type { OrganizationAgentTaskDto } from '../../contracts';
import type { TeamTask, TeamTaskWithKanban } from '@shared/types';

export interface OrganizationInspectorTaskBindings {
  contextId: string;
  tasks: TeamTaskWithKanban[];
  taskMap: Map<string, TeamTask>;
  actionErrors: { contextId: string; teamName: string; taskId: string; message: string }[];
  dismissTaskActionError: (taskId: string) => void;
  memberColorMap: Map<string, string>;
  kanbanTaskStateById:
    | NonNullable<ReturnType<typeof selectTeamDataForName>>['kanbanState']['tasks']
    | undefined;
  openTaskDetail: (task: TeamTask) => void;
  openTaskSummaryDetail: (task: OrganizationAgentTaskDto) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onApproveTask: (taskId: string) => void;
  onRequestReview: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
}

function isTaskContextCurrent(contextId: string): boolean {
  const state = useStore.getState();
  return !state.isContextSwitching && state.activeContextId === contextId;
}

export function useOrganizationInspectorTasks(teamName: string): OrganizationInspectorTaskBindings {
  const [actionErrors, setActionErrors] = useState<
    { contextId: string; teamName: string; taskId: string; message: string }[]
  >([]);
  const {
    contextId,
    globalTasks,
    members,
    openGlobalTaskDetail,
    requestReview,
    startTaskByUser,
    teamData,
    updateKanban,
    updateTaskStatus,
  } = useStore(
    useShallow((state) => ({
      contextId: state.activeContextId,
      globalTasks: state.globalTasks,
      members: selectResolvedMembersForTeamName(state, teamName),
      openGlobalTaskDetail: state.openGlobalTaskDetail,
      requestReview: state.requestReview,
      startTaskByUser: state.startTaskByUser,
      teamData: selectTeamDataForName(state, teamName),
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
      try {
        void Promise.resolve(action()).then(release, handleError);
      } catch (error) {
        handleError(error);
      }
    },
    [contextId, teamName]
  );

  const tasks = useMemo<TeamTaskWithKanban[]>(() => {
    if (!teamName) return [];
    if (teamData?.tasks) return teamData.tasks;
    return globalTasks.filter((task) => task.teamName === teamName);
  }, [globalTasks, teamData?.tasks, teamName]);

  const taskMap = useMemo<Map<string, TeamTask>>(() => {
    const map = new Map<string, TeamTask>();
    for (const task of tasks) {
      map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const memberColorMap = useMemo(() => buildMemberColorMap(members), [members]);

  const openTaskById = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      openGlobalTaskDetail(teamName, taskId);
    },
    [openGlobalTaskDetail, teamName]
  );

  const openTaskDetail = useCallback(
    (task: TeamTask): void => {
      openTaskById(task.id);
    },
    [openTaskById]
  );

  const openTaskSummaryDetail = useCallback(
    (task: OrganizationAgentTaskDto): void => {
      openTaskById(task.id);
    },
    [openTaskById]
  );

  const onRequestChanges = useCallback(
    (taskId: string): void => {
      if (!isTaskContextCurrent(contextId) || isTaskActionInFlight({ contextId, teamName, taskId }))
        return;
      openTaskById(taskId);
    },
    [contextId, openTaskById, teamName]
  );

  const onStartTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, async () => {
        await startTaskByUser(teamName, taskId);
      });
    },
    [runTaskAction, startTaskByUser, teamName]
  );

  const onCompleteTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, () => updateTaskStatus(teamName, taskId, 'completed'));
    },
    [runTaskAction, teamName, updateTaskStatus]
  );

  const onCancelTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, () => updateTaskStatus(teamName, taskId, 'pending'));
    },
    [runTaskAction, teamName, updateTaskStatus]
  );

  const onApproveTask = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, () =>
        updateKanban(teamName, taskId, { op: 'set_column', column: 'approved' })
      );
    },
    [runTaskAction, teamName, updateKanban]
  );

  const onRequestReview = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, () => requestReview(teamName, taskId));
    },
    [requestReview, runTaskAction, teamName]
  );

  const onMoveBackToDone = useCallback(
    (taskId: string): void => {
      if (!teamName) return;
      runTaskAction(taskId, async () => {
        await updateKanban(teamName, taskId, { op: 'remove' });
        if (!isTaskContextCurrent(contextId)) return;
        await updateTaskStatus(teamName, taskId, 'completed');
      });
    },
    [contextId, runTaskAction, teamName, updateKanban, updateTaskStatus]
  );

  return {
    contextId,
    tasks,
    taskMap,
    actionErrors: actionErrors.filter(
      (error) => error.contextId === contextId && error.teamName === teamName
    ),
    dismissTaskActionError: (taskId) =>
      setActionErrors((errors) => errors.filter((error) => error.taskId !== taskId)),
    memberColorMap,
    kanbanTaskStateById: teamData?.kanbanState.tasks,
    openTaskDetail,
    openTaskSummaryDetail,
    onStartTask,
    onCompleteTask,
    onCancelTask,
    onApproveTask,
    onRequestReview,
    onRequestChanges,
    onMoveBackToDone,
  };
}
