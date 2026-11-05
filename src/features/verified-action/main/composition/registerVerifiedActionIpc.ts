import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import * as controllerModule from 'agent-teams-controller';
import { createHash } from 'crypto';
import * as path from 'path';

import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../../contracts';
import { VerifiedActionService } from '../application/VerifiedActionService';
import { FileVerifiedActionStore } from '../infrastructure/FileVerifiedActionStore';

import type { VerifiedActionDecision } from '../../contracts';
import type { IpcMain } from 'electron';

const channels = [
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
];

function requireTask(teamName: unknown, taskId: unknown): [string, string] {
  const team = validateTeamName(teamName);
  const task = validateTaskId(taskId);
  if (!team.valid || !team.value) throw new Error(team.error ?? 'Invalid team name');
  if (!task.valid || !task.value) throw new Error(task.error ?? 'Invalid task id');
  return [team.value, task.value];
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Invalid action id');
  }
  return value;
}

export function registerVerifiedActionIpc(
  ipc: IpcMain,
  context: {
    getActiveContextId(): string;
    isLocal(): boolean;
    withAdmission<T>(operation: () => Promise<T>): Promise<T>;
  }
): void {
  const currentScope = (expectedContext: unknown): string => {
    if (
      expectedContext !== 'local' ||
      context.getActiveContextId() !== 'local' ||
      !context.isLocal()
    ) {
      throw new Error('Verified actions are available only in the active local context');
    }
    return createHash('sha256').update(path.resolve(getClaudeBasePath())).digest('hex');
  };
  const store = new FileVerifiedActionStore(path.join(getAppDataPath(), 'verified-actions'));
  const run = <T>(contextId: unknown, operation: (scope: string) => Promise<T>): Promise<T> => {
    const expectedScope = currentScope(contextId);
    return context.withAdmission(async () => {
      if (currentScope(contextId) !== expectedScope) throw new Error('The active context changed');
      return operation(expectedScope);
    });
  };
  const service = new VerifiedActionService({
    store,
    verify: async (scope, teamName, taskId) => {
      if (scope !== currentScope('local')) throw new Error('The active context changed');
      const controller = controllerModule.createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      });
      return controller.taskBoard.verifyTaskArtifact(taskId);
    },
    enqueue: (action) => {
      if (action.scope !== currentScope('local')) throw new Error('The active context changed');
      return store.enqueue(action);
    },
  });

  ipc.handle(
    VERIFIED_ACTION_LIST,
    (_event, contextId: unknown, teamName: unknown, taskId: unknown) => {
      const [team, task] = requireTask(teamName, taskId);
      return run(contextId, (scope) => service.list(scope, team, task));
    }
  );
  ipc.handle(
    VERIFIED_ACTION_PREPARE,
    (_event, contextId: unknown, teamName: unknown, taskId: unknown) => {
      const [team, task] = requireTask(teamName, taskId);
      return run(contextId, (scope) => service.prepare(scope, team, task));
    }
  );
  ipc.handle(VERIFIED_ACTION_APPROVE, (_event, contextId: unknown, id: unknown) =>
    run(contextId, (scope) => service.approve(scope, requireId(id)))
  );
  ipc.handle(
    VERIFIED_ACTION_DECIDE,
    (_event, contextId: unknown, id: unknown, decision: unknown) => {
      if (
        decision !== 'completed' &&
        decision !== 'retry_once' &&
        decision !== 'leave_unresolved'
      ) {
        throw new Error('Invalid action decision');
      }
      return run(contextId, (scope) =>
        service.decide(scope, requireId(id), decision as VerifiedActionDecision)
      );
    }
  );
}

export function removeVerifiedActionIpc(ipc: IpcMain): void {
  channels.forEach((channel) => ipc.removeHandler(channel));
}
