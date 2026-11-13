import { getReviewStateFromTask } from '@shared/utils/reviewState';

import { buildTaskChangePresenceDescriptor } from './taskChangePresenceUtils';
import { getTeamTaskWorkflowColumn } from './teamTaskActiveState';

import type { PersistedTaskChangePresenceIndex } from './cache/taskChangePresenceCacheTypes';
import type {
  KanbanState,
  TaskChangePresenceState,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';

interface TaskChangeLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

/** Pure board overlays and change-presence projection. */
export class TeamDataTaskSnapshotProjection {
  resolveTaskReviewState(
    task: Pick<TeamTask, 'reviewState' | 'historyEvents' | 'status'>,
    kanbanTaskState?: KanbanState['tasks'][string]
  ): 'none' | 'review' | 'needsFix' | 'approved' {
    const kanbanColumn = kanbanTaskState?.column;
    const kanbanWorkflowColumn = kanbanColumn
      ? getTeamTaskWorkflowColumn({
          status: task.status,
          reviewState: 'none',
          kanbanColumn,
        })
      : undefined;
    if (kanbanWorkflowColumn) {
      return kanbanWorkflowColumn;
    }

    const reviewState = getReviewStateFromTask({
      historyEvents: task.historyEvents,
      reviewState: task.reviewState,
      status: task.status,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });
    const workflowColumn = getTeamTaskWorkflowColumn({
      status: task.status,
      reviewState,
      ...(kanbanColumn ? { kanbanColumn } : {}),
    });

    if (workflowColumn) {
      return workflowColumn;
    }

    return reviewState;
  }

  attachKanbanCompatibility(
    task: TeamTask,
    kanbanTaskState?: KanbanState['tasks'][string]
  ): TeamTaskWithKanban {
    const reviewState = this.resolveTaskReviewState(task, kanbanTaskState);
    const reviewer = this.resolveReviewerFromHistory(task, kanbanTaskState, reviewState) ?? null;
    const kanbanColumn = this.resolveTaskKanbanColumn(task, kanbanTaskState, reviewState);
    return {
      ...task,
      reviewState,
      ...(kanbanColumn ? { kanbanColumn } : {}),
      reviewer,
    };
  }
  resolveTaskKanbanColumn(
    task: Pick<TeamTask, 'status'>,
    kanbanTaskState?: KanbanState['tasks'][string],
    reviewState: 'none' | 'review' | 'needsFix' | 'approved' = 'none'
  ): 'review' | 'approved' | undefined {
    return getTeamTaskWorkflowColumn({
      status: task.status,
      reviewState,
      ...(kanbanTaskState?.column ? { kanbanColumn: kanbanTaskState.column } : {}),
    });
  }

  /**
   * Extract reviewer name from the current review cycle history.
   * For legacy boards that stored reviewer only in kanban state, preserve that
   * value as a migration fallback while the task is still actively in review.
   */
  resolveReviewerFromHistory(
    task: TeamTask,
    kanbanTaskState?: KanbanState['tasks'][string],
    reviewState: 'none' | 'review' | 'needsFix' | 'approved' = this.resolveTaskReviewState(
      task,
      kanbanTaskState
    )
  ): string | null {
    if (reviewState !== 'review') {
      return null;
    }

    if (task.historyEvents?.length) {
      for (let i = task.historyEvents.length - 1; i >= 0; i--) {
        const event = task.historyEvents[i];
        if (event.type === 'review_started' && event.actor) {
          return event.actor;
        }
        if (event.type === 'review_requested' && event.reviewer) {
          return event.reviewer;
        }
        if (event.type === 'review_approved' || event.type === 'review_changes_requested') {
          break;
        }
        if (
          event.type === 'status_changed' &&
          (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted')
        ) {
          break;
        }
        if (event.type === 'task_created') {
          break;
        }
      }
    }

    if (
      reviewState === 'review' &&
      kanbanTaskState?.column === 'review' &&
      typeof kanbanTaskState.reviewer === 'string' &&
      kanbanTaskState.reviewer.trim().length > 0
    ) {
      return kanbanTaskState.reviewer.trim();
    }

    return null;
  }
  resolveTaskChangePresenceMap(
    tasks: readonly TeamTaskWithKanban[],
    changePresenceEnabled: boolean,
    presenceIndex: PersistedTaskChangePresenceIndex | null,
    logSourceSnapshot: TaskChangeLogSourceSnapshot | null
  ): Record<string, TaskChangePresenceState> {
    const result: Record<string, TaskChangePresenceState> = {};
    if (
      !changePresenceEnabled ||
      !presenceIndex ||
      !logSourceSnapshot?.projectFingerprint ||
      !logSourceSnapshot.logSourceGeneration ||
      presenceIndex.projectFingerprint !== logSourceSnapshot.projectFingerprint ||
      presenceIndex.logSourceGeneration !== logSourceSnapshot.logSourceGeneration
    ) {
      for (const task of tasks) {
        result[task.id] = 'unknown';
      }
      return result;
    }

    for (const task of tasks) {
      const descriptor = buildTaskChangePresenceDescriptor({
        createdAt: task.createdAt,
        owner: task.owner,
        status: task.status,
        intervals: task.workIntervals,
        reviewState: task.reviewState,
        historyEvents: task.historyEvents,
        kanbanColumn: task.kanbanColumn,
      });
      const presenceEntry = presenceIndex.entries[task.id];
      result[task.id] =
        presenceEntry?.taskSignature === descriptor.taskSignature &&
        presenceEntry.logSourceGeneration === logSourceSnapshot.logSourceGeneration
          ? presenceEntry.presence
          : 'unknown';
    }

    return result;
  }
}
