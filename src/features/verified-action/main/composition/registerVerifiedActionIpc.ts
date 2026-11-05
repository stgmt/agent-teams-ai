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

function currentScope(): string {
  return createHash('sha256').update(path.resolve(getClaudeBasePath())).digest('hex');
}

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

export function registerVerifiedActionIpc(ipc: IpcMain): void {
  const store = new FileVerifiedActionStore(path.join(getAppDataPath(), 'verified-actions'));
  const service = new VerifiedActionService({
    store,
    verify: async (scope, teamName, taskId) => {
      if (scope !== currentScope()) throw new Error('The active context changed');
      const controller = controllerModule.createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      });
      return controller.taskBoard.verifyTaskArtifact(taskId);
    },
    enqueue: (action) => store.enqueue(action),
  });

  ipc.handle(VERIFIED_ACTION_LIST, (_event, teamName: unknown, taskId: unknown) => {
    const [team, task] = requireTask(teamName, taskId);
    return service.list(currentScope(), team, task);
  });
  ipc.handle(VERIFIED_ACTION_PREPARE, (_event, teamName: unknown, taskId: unknown) => {
    const [team, task] = requireTask(teamName, taskId);
    return service.prepare(currentScope(), team, task);
  });
  ipc.handle(VERIFIED_ACTION_APPROVE, (_event, id: unknown) =>
    service.approve(currentScope(), requireId(id))
  );
  ipc.handle(VERIFIED_ACTION_DECIDE, (_event, id: unknown, decision: unknown) => {
    if (decision !== 'completed' && decision !== 'retry_once' && decision !== 'leave_unresolved') {
      throw new Error('Invalid action decision');
    }
    return service.decide(currentScope(), requireId(id), decision as VerifiedActionDecision);
  });
}

export function removeVerifiedActionIpc(ipc: IpcMain): void {
  channels.forEach((channel) => ipc.removeHandler(channel));
}
