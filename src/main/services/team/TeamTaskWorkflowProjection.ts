import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { getTeamTaskWorkflowColumn } from './teamTaskActiveState';

import type { KanbanState, TeamTask } from '@shared/types';

export type TeamTaskReviewState = 'none' | 'review' | 'needsFix' | 'approved';

export function resolveTaskReviewState(
  task: Pick<TeamTask, 'reviewState' | 'historyEvents' | 'status'>,
  kanbanTaskState?: KanbanState['tasks'][string]
): TeamTaskReviewState {
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

export function resolveTaskKanbanColumn(
  task: Pick<TeamTask, 'status'>,
  kanbanTaskState?: KanbanState['tasks'][string],
  reviewState: TeamTaskReviewState = 'none'
): 'review' | 'approved' | undefined {
  return getTeamTaskWorkflowColumn({
    status: task.status,
    reviewState,
    ...(kanbanTaskState?.column ? { kanbanColumn: kanbanTaskState.column } : {}),
  });
}
