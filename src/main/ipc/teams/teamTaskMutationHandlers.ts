import { createLogger } from '@shared/utils/logger';
import { type IpcMainInvokeEvent } from 'electron';

import { validateTaskId, validateTeamName } from '../guards';

import * as artifactWrite from './artifactBoundAdmission';
import { validateTaskArtifactFields } from './taskArtifactFields';

import type { TeamDataService } from '@main/services';
import type {
  TeamMessagingApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { IpcResult, TaskFieldUpdates } from '@shared/types';

const logger = createLogger('IPC:teams');

export interface TeamTaskMutationDependencies {
  getTeamDataService(): Pick<
    TeamDataService,
    'updateTaskFields' | 'addTaskRelationship' | 'removeTaskRelationship'
  >;
  getTeamRuntimeApi(): Pick<TeamRuntimeApi, 'isTeamAlive'>;
  getTeamMessagingApi(): Pick<TeamMessagingApi, 'sendMessageToTeam'>;
  wrapTeamHandler<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>>;
}

/** Task mutations retain registry writes and human-change notifications together. */
export function createTeamTaskMutationHandlers(deps: TeamTaskMutationDependencies) {
  const { getTeamDataService, getTeamRuntimeApi, getTeamMessagingApi, wrapTeamHandler } = deps;
  async function handleUpdateTaskFields(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    fields: unknown
  ): Promise<IpcResult<void>> {
    const vTeam = validateTeamName(teamName);
    if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
    const vTask = validateTaskId(taskId);
    if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
    const tid = vTask.value!;
    if (!fields || typeof fields !== 'object') {
      return { success: false, error: 'fields must be an object' };
    }
    const { subject, description, groupChatId } = fields as {
      subject?: unknown;
      description?: unknown;
      groupChatId?: unknown;
    };
    if (subject !== undefined) {
      if (typeof subject !== 'string') return { success: false, error: 'subject must be a string' };
      if (subject.trim().length === 0) return { success: false, error: 'subject cannot be empty' };
      if (subject.length > 500)
        return { success: false, error: 'subject must be 500 characters or less' };
    }
    if (description !== undefined && typeof description !== 'string') {
      return { success: false, error: 'description must be a string' };
    }
    if (groupChatId !== undefined && groupChatId !== null && typeof groupChatId !== 'string') {
      return { success: false, error: 'groupChatId must be a UUID string or null' };
    }
    const artifactFields = validateTaskArtifactFields(fields as Record<string, unknown>);
    if (!artifactFields.valid) return { success: false, error: artifactFields.error };
    const validFields: TaskFieldUpdates = { ...artifactFields.value };
    if (typeof subject === 'string') validFields.subject = subject.trim();
    if (typeof description === 'string') validFields.description = description;
    if (groupChatId === null || typeof groupChatId === 'string')
      validFields.groupChatId = groupChatId;
    if (Object.keys(validFields).length === 0) {
      return { success: false, error: 'At least one field must be provided' };
    }
    return wrapTeamHandler('updateTaskFields', async () => {
      const tn = vTeam.value!;
      await artifactWrite.runArtifactBoundUpdate(validFields, artifactFields, () =>
        getTeamDataService().updateTaskFields(tn, tid, validFields)
      );
      // Notify the lead about updated task fields
      if (getTeamRuntimeApi().isTeamAlive(tn)) {
        const changedParts: string[] = [];
        if (validFields.subject) changedParts.push('title');
        if (validFields.description !== undefined) changedParts.push('description');
        if (validFields.groupChatId !== undefined) changedParts.push('group chat');
        if (artifactWrite.hasArtifactFields(validFields)) changedParts.push('artifact requirement');
        const message =
          `Task #${tid} has been updated by the user (changed: ${changedParts.join(', ')}). ` +
          `New title: "${validFields.subject ?? '(unchanged)'}".`;
        try {
          await getTeamMessagingApi().sendMessageToTeam(tn, message);
        } catch {
          logger.warn(`Failed to notify lead about task fields update for #${tid} in ${tn}`);
        }
      }
    });
  }
  const VALID_RELATIONSHIP_TYPES = ['blockedBy', 'blocks', 'related'] as const;
  type RelationshipType = (typeof VALID_RELATIONSHIP_TYPES)[number];

  async function handleAddTaskRelationship(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    targetId: unknown,
    type: unknown
  ): Promise<IpcResult<void>> {
    const vTeam = validateTeamName(teamName);
    if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
    const vTask = validateTaskId(taskId);
    if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
    const vTarget = validateTaskId(targetId);
    if (!vTarget.valid) return { success: false, error: vTarget.error ?? 'Invalid targetId' };
    if (typeof type !== 'string' || !VALID_RELATIONSHIP_TYPES.includes(type as RelationshipType)) {
      return {
        success: false,
        error: `type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`,
      };
    }

    return wrapTeamHandler('addTaskRelationship', () =>
      getTeamDataService().addTaskRelationship(
        vTeam.value!,
        vTask.value!,
        vTarget.value!,
        type as RelationshipType
      )
    );
  }

  async function handleRemoveTaskRelationship(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    targetId: unknown,
    type: unknown
  ): Promise<IpcResult<void>> {
    const vTeam = validateTeamName(teamName);
    if (!vTeam.valid) return { success: false, error: vTeam.error ?? 'Invalid teamName' };
    const vTask = validateTaskId(taskId);
    if (!vTask.valid) return { success: false, error: vTask.error ?? 'Invalid taskId' };
    const vTarget = validateTaskId(targetId);
    if (!vTarget.valid) return { success: false, error: vTarget.error ?? 'Invalid targetId' };
    if (typeof type !== 'string' || !VALID_RELATIONSHIP_TYPES.includes(type as RelationshipType)) {
      return {
        success: false,
        error: `type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}`,
      };
    }

    return wrapTeamHandler('removeTaskRelationship', () =>
      getTeamDataService().removeTaskRelationship(
        vTeam.value!,
        vTask.value!,
        vTarget.value!,
        type as RelationshipType
      )
    );
  }
  return { handleUpdateTaskFields, handleAddTaskRelationship, handleRemoveTaskRelationship };
}
