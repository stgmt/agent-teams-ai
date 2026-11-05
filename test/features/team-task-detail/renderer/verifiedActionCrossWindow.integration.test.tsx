import 'fake-indexeddb/auto';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import {
  createTaskWriteGuardStorage,
  taskWriteGuardKey,
} from '@features/team-task-detail/renderer/adapters/taskWriteGuardStorage';
import { useTaskDetailSession } from '@features/team-task-detail/renderer/hooks/useTaskDetailSession';
import {
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_FENCE_DECISION,
  VERIFIED_ACTION_LIST,
} from '@features/verified-action/contracts';
import { registerVerifiedActionIpc } from '@features/verified-action/main/composition/registerVerifiedActionIpc';
import { FileVerifiedActionStore } from '@features/verified-action/main/infrastructure/FileVerifiedActionStore';
import { VerifiedActionPanel } from '@features/verified-action/renderer/VerifiedActionPanel';
import { useStore } from '@renderer/store';
import { __resetTeamSliceModuleStateForTests } from '@renderer/store/slices/teamSlice';
import {
  acceptTaskDetailLiveTeamSnapshot,
  captureTaskDetailReadScope,
} from '@renderer/store/team/taskDetailReadAuthority';
import { del } from 'idb-keyval';
import { afterEach, expect, it, vi } from 'vitest';

import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';
import type { TeamSummary, TeamTaskWithKanban, TeamViewSnapshot } from '@shared/types';
import type { IpcMain } from 'electron';

const paths = vi.hoisted(() => ({ appData: '', claude: '' }));
const mocks = vi.hoisted(() => ({
  teams: {
    getTask: vi.fn(),
    addTaskComment: vi.fn(),
    restoreTeam: vi.fn(),
    softDeleteTask: vi.fn(),
  },
  externalAgentConnection: { getConnectionInfo: vi.fn() },
  verifiedAction: {
    list: vi.fn(),
    prepare: vi.fn(),
    approve: vi.fn(),
    decide: vi.fn(),
    fenceDecision: vi.fn(),
  },
  t: (key: string) => key,
}));
vi.mock('@renderer/api', () => ({ api: mocks, isElectronMode: () => true }));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
    cleanupExpired: vi.fn(async () => {}),
  },
}));
vi.mock('@features/localization/renderer', () => ({ useAppTranslation: () => ({ t: mocks.t }) }));
vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: () => paths.appData,
  getClaudeBasePath: () => paths.claude,
}));

const identity = { contextId: 'local', teamName: 'test-team', taskId: '1' };
const rootFingerprint = 'b'.repeat(64);
const key = taskDetailKey(identity);
const initial = useStore.getState();
const tempRoots: string[] = [];
const reactRoots: ReturnType<typeof createRoot>[] = [];
const task: TeamTaskWithKanban = { id: identity.taskId, subject: 'Fixture', status: 'pending' };
const team: TeamSummary = {
  teamName: identity.teamName,
  displayName: identity.teamName,
  description: 'Fixture',
  memberCount: 0,
  taskCount: 1,
  lastActivity: null,
};
const teamSnapshot: TeamViewSnapshot = {
  teamName: identity.teamName,
  config: { name: identity.teamName },
  tasks: [task],
  members: [],
  kanbanState: { teamName: identity.teamName, reviewers: [], tasks: {} },
  processes: [],
};

afterEach(async () => {
  await act(async () => {
    for (const root of reactRoots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await del(taskWriteGuardKey({ ...identity, dataRootFingerprint: rootFingerprint }));
  const parent = await fs.promises.realpath(os.tmpdir());
  for (const root of tempRoots.splice(0)) {
    const resolved = await fs.promises.realpath(root);
    const relative = path.relative(parent, resolved);
    if (!relative.startsWith('verified-cross-window-') || relative.includes(path.sep))
      throw new Error('Refusing to remove a fixture outside its scratch parent');
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
  document.body.innerHTML = '';
});

it.each([
  { newGeneration: false, explicitlyResolved: false, confirmed: false },
  { newGeneration: true, explicitlyResolved: false, confirmed: false },
  { newGeneration: false, explicitlyResolved: true, confirmed: false },
  { newGeneration: true, explicitlyResolved: true, confirmed: false },
  { newGeneration: false, explicitlyResolved: false, confirmed: true },
  { newGeneration: true, explicitlyResolved: false, confirmed: true },
])(
  'checks another window with real IPC (new generation: $newGeneration, explicit: $explicitlyResolved, confirmed: $confirmed)',
  async ({ newGeneration, explicitlyResolved, confirmed }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-cross-window-'));
    tempRoots.push(temp);
    paths.appData = temp;
    paths.claude = path.join(temp, 'claude');
    const bound = new BoundControlContext('test-app', paths.claude);
    const oldContext = bound.snapshot();
    mocks.externalAgentConnection.getConnectionInfo.mockResolvedValue({
      context: oldContext,
      taskWriteRootFingerprint: rootFingerprint,
    });
    mocks.teams.getTask.mockResolvedValue({ ...task });
    __resetTeamSliceModuleStateForTests();
    useStore.setState(
      {
        ...initial,
        activeContextId: 'local',
        isContextSwitching: false,
        taskDetailById: {
          [key]: {
            ...createTaskDetailReadEntry(identity),
            phase: 'ready',
            full: task,
            loading: false,
          },
        },
        taskDetailSessionById: {},
        teamByName: { [identity.teamName]: team },
        teamDataCacheByName: { [identity.teamName]: teamSnapshot },
        refreshTeamData: vi.fn(async () => {
          acceptTaskDetailLiveTeamSnapshot(
            captureTaskDetailReadScope(identity.teamName, identity.contextId),
            teamSnapshot
          );
        }),
      },
      true
    );
    acceptTaskDetailLiveTeamSnapshot(
      captureTaskDetailReadScope(identity.teamName, identity.contextId),
      teamSnapshot
    );
    const actionId = 'a'.repeat(64);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const action = {
      id: actionId,
      scope: rootFingerprint,
      teamName: identity.teamName,
      taskId: identity.taskId,
      proof: { attachmentId: 'report', sha256: 'c'.repeat(64), size: 23 },
      status: 'question' as const,
      attempts: 1 as const,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const fileStore = new FileVerifiedActionStore(path.join(temp, 'verified-actions'));
    await fileStore.transaction((tx) => tx.write([action]));
    const enqueue = vi.spyOn(FileVerifiedActionStore.prototype, 'enqueue');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerVerifiedActionIpc(
      {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(channel, handler),
      } as unknown as IpcMain,
      {
        getActiveContextId: () => 'local',
        isLocal: () => true,
        getRootFingerprint: () => rootFingerprint,
        withAdmission: async (context, _root, operation) => {
          const release = bound.admit(context);
          try {
            return await operation();
          } finally {
            release();
          }
        },
      }
    );
    mocks.verifiedAction.list
      .mockReset()
      .mockImplementation((...args: unknown[]) => handlers.get(VERIFIED_ACTION_LIST)!({}, ...args));
    mocks.verifiedAction.fenceDecision
      .mockReset()
      .mockImplementation((...args: unknown[]) =>
        handlers.get(VERIFIED_ACTION_FENCE_DECISION)!({}, ...args)
      );
    mocks.verifiedAction.prepare.mockReset();
    mocks.verifiedAction.approve.mockReset();
    mocks.verifiedAction.decide.mockReset();
    const firstWindow = createTaskWriteGuardStorage();
    const secondWindow = createTaskWriteGuardStorage();
    const guardIdentity = { ...identity, dataRootFingerprint: rootFingerprint };
    const decision = {
      actionId,
      decisionId,
      decision: confirmed ? ('completed' as const) : ('retry_once' as const),
      stage: 'decision' as const,
    };
    const marker = {
      version: 1 as const,
      attemptId: 'shared-attempt',
      operation: 'manifest' as const,
      decision,
    };
    const claimId = '22222222-2222-4222-8222-222222222222';
    await firstWindow.beginDecision(guardIdentity, null, marker);
    expect(await firstWindow.markFenceSent(guardIdentity, marker, claimId)).toBe(true);
    let controller!: TaskDetailSessionController;
    const View = () => {
      const value = useTaskDetailSession({
        identity,
        surfaceId: 'second-window',
        currentTask: task,
      });
      useEffect(() => {
        controller = value;
      }, [value]);
      return (
        <VerifiedActionPanel
          contextId="local"
          teamName={identity.teamName}
          taskId={identity.taskId}
          enabled
          canMutate={() => true}
          guard={value}
        />
      );
    };
    const host = document.createElement('div');
    document.body.append(host);
    const reactRoot = createRoot(host);
    reactRoots.push(reactRoot);
    await act(async () => reactRoot.render(<View />));
    await vi.waitFor(() => expect(controller.taskWriteGuard.decision?.stage).toBe('fenceSent'));
    await vi.waitFor(() =>
      expect(
        [...host.querySelectorAll('button')].find(
          (item) => item.textContent === 'verifiedAction.guardCheck'
        )?.disabled
      ).toBe(false)
    );
    const decide = vi.fn((...args: unknown[]) =>
      handlers.get(VERIFIED_ACTION_DECIDE)!({}, ...args)
    );
    if (confirmed) {
      const completed = await decide(
        'local',
        oldContext,
        rootFingerprint,
        actionId,
        'completed',
        decisionId
      );
      expect(completed).toMatchObject({
        status: 'completed',
        completion: 'user_attested',
        decisionReceipt: { id: decisionId, decision: 'completed' },
      });
      await firstWindow.confirm(guardIdentity, marker);
      expect(await secondWindow.readDecision(guardIdentity, marker)).toEqual({
        explicitlyResolved: false,
        confirmed: true,
        marker: null,
      });
    } else if (explicitlyResolved) {
      await firstWindow.release(guardIdentity, marker, { explicitDecision: true });
      expect(await secondWindow.readDecision(guardIdentity, marker)).toEqual({
        explicitlyResolved: true,
        marker: null,
      });
    } else {
      expect(await firstWindow.releaseUnadmittedFence(guardIdentity, marker, claimId)).toBe(true);
      expect((await secondWindow.read(guardIdentity))?.decision?.stage).toBe('decision');
    }
    if (newGeneration) {
      await bound.closeAdmission();
      bound.rebind(paths.claude);
    }
    mocks.externalAgentConnection.getConnectionInfo.mockResolvedValue({
      context: bound.snapshot(),
      taskWriteRootFingerprint: rootFingerprint,
    });
    expect(controller.taskWriteGuard.decision?.stage).toBe('fenceSent');
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((item) => item.textContent === 'verifiedAction.guardCheck')
        ?.click();
    });
    await vi.waitFor(() => expect(controller.taskWriteGuard.unknown).toBe(false));
    await vi.waitFor(async () => expect(await secondWindow.read(guardIdentity)).toBeNull());
    const [result] = await fileStore.transaction((tx) => tx.read());
    if (confirmed) {
      expect(decide).toHaveBeenCalledOnce();
      expect(mocks.verifiedAction.fenceDecision).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: 'completed',
        completion: 'user_attested',
        attempts: 1,
        decisionReceipt: { id: decisionId, decision: 'completed' },
      });
      expect(host.textContent).not.toContain('verifiedAction.question');
    } else if (explicitlyResolved) {
      expect(mocks.verifiedAction.fenceDecision).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'question', attempts: 1 });
      expect(result.decisionReceipt).toBeUndefined();
      expect(host.textContent).not.toContain('verifiedAction.question');
    } else {
      expect(mocks.verifiedAction.fenceDecision).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        status: 'manual',
        attempts: 1,
        decisionReceipt: { id: decisionId, decision: 'retry_once' },
      });
    }
    expect(await secondWindow.readChosenActionIds(guardIdentity)).toEqual([actionId]);
    expect(mocks.verifiedAction.decide).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    await act(async () => reactRoot.unmount());
    reactRoots.splice(reactRoots.indexOf(reactRoot), 1);
    host.remove();
  }
);
