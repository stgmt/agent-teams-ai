import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { getAppDataPath, getClaudeBasePath } from '@main/utils/pathDecoder';
import * as controllerModule from 'agent-teams-controller';
import * as path from 'path';

import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_FENCE_DECISION,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../../contracts';
import { VerifiedActionService } from '../application/VerifiedActionService';
import { FileVerifiedActionStore } from '../infrastructure/FileVerifiedActionStore';

import type { VerifiedActionDecision } from '../../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { IpcMain } from 'electron';

const channels = [
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_FENCE_DECISION,
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

function requireDecisionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Invalid decision id');
  }
  return value;
}

function requireDecision(value: unknown): VerifiedActionDecision {
  if (value !== 'completed' && value !== 'retry_once' && value !== 'leave_unresolved') {
    throw new Error('Invalid action decision');
  }
  return value;
}

function requireExpectedContext(value: unknown): AppConnectionContext {
  if (!value || typeof value !== 'object') throw new Error('Expected app context is required');
  const context = value as Partial<AppConnectionContext>;
  if (
    typeof context.appInstanceId !== 'string' ||
    !context.appInstanceId ||
    typeof context.dataRootFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(context.dataRootFingerprint) ||
    !Number.isSafeInteger(context.connectionGeneration) ||
    (context.connectionGeneration ?? 0) < 1
  )
    throw new Error('Expected app context is invalid');
  return context as AppConnectionContext;
}

export function registerVerifiedActionIpc(
  ipc: IpcMain,
  context: {
    getActiveContextId(): string;
    isLocal(): boolean;
    getRootFingerprint(): string | null;
    withAdmission<T>(
      expected: AppConnectionContext,
      expectedRootFingerprint: string,
      operation: () => Promise<T>
    ): Promise<T>;
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
    const fingerprint = context.getRootFingerprint();
    if (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint))
      throw new Error('Task root identity is unavailable');
    return fingerprint;
  };
  const store = new FileVerifiedActionStore(path.join(getAppDataPath(), 'verified-actions'));
  const run = <T>(
    contextId: unknown,
    expected: unknown,
    root: unknown,
    operation: (scope: string) => Promise<T>
  ): Promise<T> => {
    const expectedScope = currentScope(contextId);
    if (typeof root !== 'string' || root !== expectedScope)
      throw new Error('Task root identity changed');
    return context.withAdmission(requireExpectedContext(expected), root, async () => {
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
    (
      _event,
      contextId: unknown,
      expected: unknown,
      root: unknown,
      teamName: unknown,
      taskId: unknown
    ) => {
      const [team, task] = requireTask(teamName, taskId);
      return run(contextId, expected, root, (scope) => service.list(scope, team, task));
    }
  );
  ipc.handle(
    VERIFIED_ACTION_PREPARE,
    (
      _event,
      contextId: unknown,
      expected: unknown,
      root: unknown,
      teamName: unknown,
      taskId: unknown
    ) => {
      const [team, task] = requireTask(teamName, taskId);
      return run(contextId, expected, root, (scope) => service.prepare(scope, team, task));
    }
  );
  ipc.handle(
    VERIFIED_ACTION_APPROVE,
    (_event, contextId: unknown, expected: unknown, root: unknown, id: unknown) =>
      run(contextId, expected, root, (scope) => service.approve(scope, requireId(id)))
  );
  ipc.handle(
    VERIFIED_ACTION_DECIDE,
    (
      _event,
      contextId: unknown,
      expected: unknown,
      root: unknown,
      id: unknown,
      decision: unknown,
      decisionId: unknown
    ) => {
      return run(contextId, expected, root, (scope) =>
        service.decide(
          scope,
          requireId(id),
          requireDecision(decision),
          requireDecisionId(decisionId)
        )
      );
    }
  );
  ipc.handle(
    VERIFIED_ACTION_FENCE_DECISION,
    (
      _event,
      contextId: unknown,
      expected: unknown,
      root: unknown,
      id: unknown,
      decision: unknown,
      decisionId: unknown
    ) =>
      run(contextId, expected, root, (scope) =>
        service.fenceDecision(
          scope,
          requireId(id),
          requireDecision(decision),
          requireDecisionId(decisionId)
        )
      )
  );
}

export function removeVerifiedActionIpc(ipc: IpcMain): void {
  channels.forEach((channel) => ipc.removeHandler(channel));
}
