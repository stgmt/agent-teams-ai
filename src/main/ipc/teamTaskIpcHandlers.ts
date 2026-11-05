import type { IpcMainInvokeEvent } from 'electron';
import { looksLikeCanonicalTaskId } from '@shared/utils/taskIdentity';
import type {
  CreateTaskRequest,
  IpcResult,
  TaskRef,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';
import type { TeamDataService } from '../services';
import { validateMemberName, validateTaskId, validateTeamName } from './guards';

export function validateTaskRefs(
  value: unknown
): { valid: true; value: TaskRef[] | undefined } | { valid: false; error: string } {
  if (value === undefined) {
    return { valid: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { valid: false, error: 'taskRefs must be an array' };
  }

  const taskRefs: TaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: 'taskRefs entries must be objects' };
    }
    const row = entry as Partial<TaskRef>;
    const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
    const displayId = typeof row.displayId === 'string' ? row.displayId.trim() : '';
    const teamName = typeof row.teamName === 'string' ? row.teamName.trim() : '';
    if (!taskId || !displayId || !teamName) {
      return { valid: false, error: 'Each taskRef must include taskId, displayId, and teamName' };
    }
    const validatedTaskId = validateTaskId(taskId);
    if (!validatedTaskId.valid) {
      return { valid: false, error: validatedTaskId.error ?? 'Invalid taskRef taskId' };
    }
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { valid: false, error: validatedTeamName.error ?? 'Invalid taskRef teamName' };
    }
    taskRefs.push({
      taskId: validatedTaskId.value!,
      displayId,
      teamName: validatedTeamName.value!,
    });
  }

  return { valid: true, value: taskRefs };
}

interface TeamTaskIpcHandlerDependencies {
  getTeamDataService: () => Pick<TeamDataService, 'createTask' | 'getTask'>;
  wrapTeamHandler: <T>(operation: string, handler: () => Promise<T>) => Promise<IpcResult<T>>;
}

export function createTeamTaskIpcHandlers({
  getTeamDataService,
  wrapTeamHandler,
}: TeamTaskIpcHandlerDependencies): {
  handleCreateTask: (
    event: IpcMainInvokeEvent,
    teamName: unknown,
    request: unknown
  ) => Promise<IpcResult<TeamTask>>;
  handleGetTask: (
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ) => Promise<IpcResult<TeamTaskWithKanban | null>>;
} {
  async function handleCreateTask(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    request: unknown
  ): Promise<IpcResult<TeamTask>> {
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
    }

    if (!request || typeof request !== 'object') {
      return { success: false, error: 'Invalid create task request' };
    }

    const payload = request as Partial<CreateTaskRequest>;
    let command: CreateTaskRequest['command'];
    if (payload.command !== undefined) {
      if (!payload.command || typeof payload.command !== 'object') {
        return { success: false, error: 'command must be an object' };
      }
      const commandId = payload.command.commandId;
      const idempotencyKey = payload.command.idempotencyKey;
      if (typeof commandId !== 'string' || !looksLikeCanonicalTaskId(commandId)) {
        return { success: false, error: 'command.commandId must be a UUID' };
      }
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.trim().length === 0 ||
        idempotencyKey.trim().length > 200
      ) {
        return {
          success: false,
          error: 'command.idempotencyKey must be a non-empty string up to 200 characters',
        };
      }
      command = {
        commandId: commandId.trim(),
        idempotencyKey: idempotencyKey.trim(),
      };
    }
    if (typeof payload.subject !== 'string' || payload.subject.trim().length === 0) {
      return { success: false, error: 'subject must be a non-empty string' };
    }
    if (payload.subject.trim().length > 500) {
      return { success: false, error: 'subject exceeds max length (500)' };
    }
    if (payload.description !== undefined && typeof payload.description !== 'string') {
      return { success: false, error: 'description must be string' };
    }
    const validatedDescriptionTaskRefs = validateTaskRefs(payload.descriptionTaskRefs);
    if (!validatedDescriptionTaskRefs.valid) {
      return { success: false, error: validatedDescriptionTaskRefs.error };
    }
    if (payload.requirements !== undefined) {
      if (
        !Array.isArray(payload.requirements) ||
        payload.requirements.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
        payload.requirements.length > 50
      ) {
        return {
          success: false,
          error: 'requirements must be an array of up to 50 non-empty requirement ids',
        };
      }
    }
    if (payload.tracking !== undefined) {
      if (typeof payload.tracking !== 'string' || payload.tracking.length > 2000) {
        return { success: false, error: 'tracking must be a string up to 2000 characters' };
      }
    }
    if (payload.groupChatId !== undefined && typeof payload.groupChatId !== 'string') {
      return { success: false, error: 'groupChatId must be a UUID string' };
    }
    if (payload.owner !== undefined) {
      const validatedOwner = validateMemberName(payload.owner);
      if (!validatedOwner.valid) {
        return { success: false, error: validatedOwner.error ?? 'Invalid owner' };
      }
    }
    if (payload.blockedBy !== undefined) {
      if (
        !Array.isArray(payload.blockedBy) ||
        payload.blockedBy.some((id) => typeof id !== 'string')
      ) {
        return { success: false, error: 'blockedBy must be an array of task ID strings' };
      }
    }
    if (payload.related !== undefined) {
      if (!Array.isArray(payload.related) || payload.related.some((id) => typeof id !== 'string')) {
        return { success: false, error: 'related must be an array of task ID strings' };
      }
      for (const id of payload.related) {
        const validated = validateTaskId(id);
        if (!validated.valid) {
          return { success: false, error: validated.error ?? 'Invalid related task id' };
        }
      }
    }
    if (payload.prompt !== undefined) {
      if (typeof payload.prompt !== 'string') {
        return { success: false, error: 'prompt must be a string' };
      }
      if (payload.prompt.length > 5000) {
        return { success: false, error: 'prompt exceeds max length (5000)' };
      }
    }
    const validatedPromptTaskRefs = validateTaskRefs(payload.promptTaskRefs);
    if (!validatedPromptTaskRefs.valid) {
      return { success: false, error: validatedPromptTaskRefs.error };
    }
    if (payload.startImmediately !== undefined && typeof payload.startImmediately !== 'boolean') {
      return { success: false, error: 'startImmediately must be a boolean' };
    }

    return wrapTeamHandler('createTask', () =>
      getTeamDataService().createTask(validatedTeamName.value!, {
        ...(command ? { command } : {}),
        subject: payload.subject!.trim(),
        description: payload.description?.trim(),
        requirements: payload.requirements?.map((id) => id.trim()),
        tracking: payload.tracking?.trim() || undefined,
        groupChatId: payload.groupChatId,
        owner: payload.owner?.trim() || undefined,
        blockedBy: payload.blockedBy,
        related: payload.related,
        descriptionTaskRefs: validatedDescriptionTaskRefs.value,
        prompt: payload.prompt?.trim() || undefined,
        promptTaskRefs: validatedPromptTaskRefs.value,
        startImmediately: payload.startImmediately,
      })
    );
  }

  async function handleGetTask(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<TeamTaskWithKanban | null>> {
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
    }

    const validatedTaskId = validateTaskId(taskId);
    if (!validatedTaskId.valid) {
      return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
    }

    return wrapTeamHandler('getTask', () =>
      getTeamDataService().getTask(validatedTeamName.value!, validatedTaskId.value!)
    );
  }

  return { handleCreateTask, handleGetTask };
}
