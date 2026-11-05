import { localIdFromRef, normalizeLocalId, REGISTRY_TO_TEAM_STATUS } from './RegistryTaskIdentity';

import type { ExecutionTaskStore } from '../execution/ExecutionTaskStore';
import type { RegistryTask } from './RegistryTaskClientTypes';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { TaskHistoryEvent, TeamTask } from '@shared/types';

export function taskCreationTimestamp(
  events: readonly TaskHistoryEvent[] | undefined
): string | undefined {
  return events?.find((event) => event.type === 'task_created')?.timestamp;
}

export function executionFields(
  executionStore: Pick<ExecutionTaskStore, 'read'>,
  teamName: string,
  localId: string
): Partial<TeamTask> {
  const record = executionStore.read(teamName, localId);
  if (!record) return {};
  const createdAt = taskCreationTimestamp(record.historyEvents);
  return {
    ...(createdAt ? { createdAt } : {}),
    ...(record.workIntervals.length > 0 ? { workIntervals: record.workIntervals } : {}),
    ...(record.reviewIntervals.length > 0 ? { reviewIntervals: record.reviewIntervals } : {}),
    ...(record.comments.length > 0 ? { comments: record.comments } : {}),
    ...(record.attachments.length > 0 ? { attachments: record.attachments } : {}),
    ...(record.historyEvents.length > 0 ? { historyEvents: record.historyEvents } : {}),
    ...(record.needsClarification ? { needsClarification: record.needsClarification } : {}),
    ...(record.reviewState !== undefined ? { reviewState: record.reviewState } : {}),
    ...(record.activeForm !== undefined ? { activeForm: record.activeForm } : {}),
    ...(record.groupChatId !== undefined ? { groupChatId: record.groupChatId } : {}),
    ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
    ...(record.projectPath !== undefined ? { projectPath: record.projectPath } : {}),
    ...(record.descriptionTaskRefs !== undefined
      ? { descriptionTaskRefs: record.descriptionTaskRefs }
      : {}),
    ...(record.promptTaskRefs !== undefined ? { promptTaskRefs: record.promptTaskRefs } : {}),
    ...(record.sourceMessageId !== undefined ? { sourceMessageId: record.sourceMessageId } : {}),
    ...(record.sourceMessage !== undefined ? { sourceMessage: record.sourceMessage } : {}),
    ...(record.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
    ...(record.creationCommand !== undefined ? { creationCommand: record.creationCommand } : {}),
    updatedAt: record.updatedAt,
  };
}

export function registryTaskToTeamTask(
  current: RegistryTask,
  binding: TeamSpecBinding,
  teamName: string,
  executionStore: Pick<ExecutionTaskStore, 'read'>
): TeamTask {
  const localId = normalizeLocalId(current.localId) ?? current.localId;
  const linkLocalIds = (refs: readonly string[]): string[] => [
    ...new Set(
      refs
        .map((ref) => localIdFromRef(binding.spec, ref))
        .filter((value): value is string => value !== null)
    ),
  ];
  return {
    id: localId,
    displayId: localId,
    subject: current.title,
    ...(current.body !== undefined ? { description: current.body } : {}),
    ...(current.owner ? { owner: current.owner } : {}),
    status: REGISTRY_TO_TEAM_STATUS[current.status],
    ...(current.blockedBy.length > 0 ? { blockedBy: linkLocalIds(current.blockedBy) } : {}),
    ...(current.blocks.length > 0 ? { blocks: linkLocalIds(current.blocks) } : {}),
    ...(current.refs.length > 0 ? { related: linkLocalIds(current.refs) } : {}),
    ...executionFields(executionStore, teamName, localId),
  };
}
