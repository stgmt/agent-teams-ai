import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import 'fake-indexeddb/auto';

import { createTaskDetailReadEntry, taskDetailKey } from '@features/team-task-detail/core';
import { TaskDetailEditorActivationFeedback } from '@features/team-task-detail/renderer/adapters/TaskDetailEditorActivationFeedback';
import { TaskDetailReadCoordinator } from '@features/team-task-detail/renderer/adapters/TaskDetailReadCoordinator';
import { useTaskDetailEditorHost } from '@features/team-task-detail/renderer/hooks/useTaskDetailEditorHost';
import { useTaskDetailReviewRoute } from '@features/team-task-detail/renderer/hooks/useTaskDetailReviewRoute';
import { useTaskDetailSession } from '@features/team-task-detail/renderer/hooks/useTaskDetailSession';
import {
  taskWriteGuardKey,
  taskWriteGuardStorage,
} from '@features/team-task-detail/renderer/adapters/taskWriteGuardStorage';
import { resetWorkspaceForRootChange } from '@renderer/components/settings/resetWorkspaceForRootChange';
import { useStore } from '@renderer/store';
import { __resetTeamSliceModuleStateForTests } from '@renderer/store/slices/teamSlice';
import {
  acceptTaskDetailLiveTeamSnapshot,
  captureTaskDetailReadScope,
} from '@renderer/store/team/taskDetailReadAuthority';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { del } from 'idb-keyval';

import type { TaskDetailIdentity } from '@features/team-task-detail/contracts';
import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';
import type { TaskComment, TeamSummary, TeamTaskWithKanban, TeamViewSnapshot } from '@shared/types';

const apiMock = vi.hoisted(() => ({
  teams: {
    addTaskComment: vi.fn(),
    getTask: vi.fn(),
    restoreTeam: vi.fn(),
    softDeleteTask: vi.fn(),
  },
  externalAgentConnection: { getConnectionInfo: vi.fn() },
}));
vi.mock('@renderer/api', () => ({ api: apiMock, isElectronMode: () => true }));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async () => null),
    saveDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
    cleanupExpired: vi.fn(async () => {}),
  },
}));

const initial = useStore.getState();
const identity: TaskDetailIdentity = { contextId: 'local', teamName: 'TEST-team', taskId: '1' };
const guardContext = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'a'.repeat(64),
  connectionGeneration: 1,
};
const key = taskDetailKey(identity);
const task: TeamTaskWithKanban = { id: '1', subject: 'TEST task', status: 'pending' };
const teamDeletedAt = '2026-10-14T18:00:00.000Z';
const teamSummary: TeamSummary = {
  teamName: identity.teamName,
  displayName: identity.teamName,
  description: 'TEST team',
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
const roots: ReturnType<typeof createRoot>[] = [];

function acceptLiveTeamSnapshotFixture(
  teamName: string,
  snapshot: TeamViewSnapshot = {
    ...teamSnapshot,
    teamName,
    config: { ...teamSnapshot.config, name: teamName },
  }
) {
  const existing = useStore.getState();
  if (
    existing.teamByName[teamName]?.deletedAt ||
    existing.teamDataCacheByName[teamName]?.config.deletedAt
  ) {
    return;
  }
  acceptTaskDetailLiveTeamSnapshot(
    captureTaskDetailReadScope(teamName, identity.contextId),
    snapshot
  );
  useStore.setState((state) => ({
    teamByName: {
      ...state.teamByName,
      [teamName]: {
        ...(state.teamByName[teamName] ?? teamSummary),
        teamName,
        displayName: teamName,
      },
    },
    teamDataCacheByName: {
      ...state.teamDataCacheByName,
      [teamName]: snapshot,
    },
  }));
}

function mount(surfaceId: string, receive: (controller: TaskDetailSessionController) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const View = () => {
    const controller = useTaskDetailSession({
      identity: { ...identity },
      surfaceId,
      currentTask: task,
    });
    useEffect(() => {
      receive(controller);
    }, [controller]);
    return React.createElement(
      'span',
      { 'data-owner': controller.isOwner },
      controller.session.commentText
    );
  };
  root.render(React.createElement(View));
  return root;
}

describe('task session surface and origin integration', () => {
  beforeEach(async () => {
    await del(
      taskWriteGuardKey({ ...identity, dataRootFingerprint: guardContext.dataRootFingerprint })
    );
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    apiMock.externalAgentConnection.getConnectionInfo.mockResolvedValue({
      context: guardContext,
      taskWriteRootFingerprint: guardContext.dataRootFingerprint,
    });
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
        teamByName: { [identity.teamName]: teamSummary },
        teamDataCacheByName: { [identity.teamName]: teamSnapshot },
        refreshTeamData: vi.fn(async (teamName: string) => {
          acceptLiveTeamSnapshotFixture(teamName);
        }),
      },
      true
    );
    acceptLiveTeamSnapshotFixture(identity.teamName);
  });
  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  async function waitForGuard(): Promise<void> {
    await vi.waitFor(() =>
      expect(useStore.getState().taskDetailSessionById[key]?.taskWriteGuardState).toBe('ready')
    );
  }

  async function makeUnknown(controller: TaskDetailSessionController): Promise<string> {
    await waitForGuard();
    let token = '';
    await act(async () => {
      ({ token } = await controller.beginGuardedTaskWrite('artifact'));
      await controller.settleGuardedTaskWrite(token, 'artifact', 'unknown');
    });
    return token;
  }

  it('keeps the guard ready when another window already recorded the answer', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await waitForGuard();
    const guardIdentity = { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint };
    const marker = {
      version: 1 as const,
      attemptId: 'other-window',
      operation: 'manifest' as const,
      decision: {
        actionId: 'b'.repeat(64),
        decisionId: '11111111-1111-4111-8111-111111111111',
        decision: 'retry_once' as const,
        stage: 'decision' as const,
      },
    };
    await taskWriteGuardStorage.beginDecision(guardIdentity, null, marker);
    await taskWriteGuardStorage.release(guardIdentity, marker);
    await act(async () => {
      await expect(
        controller.beginGuardedTaskDecision(marker.decision.actionId, 'retry_once')
      ).rejects.toThrow();
    });
    expect(controller.taskWriteGuard).toMatchObject({
      status: 'ready',
      markerId: null,
      unknown: false,
    });
    expect(await controller.readGuardedTaskDecisionIds()).toContain(marker.decision.actionId);
  });

  it('requires a fresh task read and an explicit decision before clearing an unknown artifact outcome', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await makeUnknown(controller);
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
    await act(async () => {
      await expect(controller.confirmArtifactOutcome()).rejects.toThrow(/Check the matching/);
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
    apiMock.teams.getTask.mockResolvedValueOnce({
      ...task,
      artifactRequirement: { required: true, expectedFilename: 'result.txt' },
    });
    await act(async () => {
      await controller.checkArtifactOutcome();
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
    expect(
      useStore.getState().taskDetailById[key].full?.artifactRequirement?.expectedFilename
    ).toBe('result.txt');
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeChecked).toBe(true);
    await act(async () => {
      await controller.confirmArtifactOutcome();
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(false);
  });

  it('accepts an explicit decision if another renderer has already cleared the same marker', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    const token = await makeUnknown(controller);
    const guardIdentity = { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint };
    await taskWriteGuardStorage.release(guardIdentity, {
      version: 1,
      attemptId: token,
      operation: 'artifact',
    });
    apiMock.teams.getTask.mockResolvedValueOnce({ ...task });
    await act(async () => {
      await controller.checkGuardedTaskWriteOutcome('artifact');
      await controller.confirmGuardedTaskWriteOutcome(token, 'artifact');
    });
    expect(controller.taskWriteGuard).toMatchObject({
      unknown: false,
      markerId: null,
      status: 'ready',
    });
  });

  it('keeps an unknown artifact outcome when the fresh task read fails', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await makeUnknown(controller);
    apiMock.teams.getTask.mockRejectedValueOnce(new Error('read failed'));
    await act(async () => {
      await expect(controller.checkArtifactOutcome()).rejects.toThrow(/confirm/);
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeChecked).toBe(false);
    vi.mocked(console.error).mockClear();
  });

  it('does not issue another artifact write while the outcome is unknown', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    const update = vi.fn(async () => undefined);
    useStore.setState({ updateTaskFields: update });
    await makeUnknown(controller);
    await expect(controller.updateTaskArtifact({ artifactRequired: true })).rejects.toThrow(
      /No task write was sent/
    );
    expect(update).not.toHaveBeenCalled();
    await act(async () => {
      await expect(controller.confirmArtifactOutcome()).rejects.toThrow(/Check the matching/);
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
  });

  it('recovers a manifest marker and only clears it after the matching operation is checked and confirmed', async () => {
    const marker = {
      version: 1 as const,
      attemptId: 'persisted-attempt',
      operation: 'manifest' as const,
    };
    await taskWriteGuardStorage.acquire(
      { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint },
      marker
    );
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await waitForGuard();
    expect(controller.taskWriteGuard).toMatchObject({
      unknown: true,
      markerId: marker.attemptId,
      operation: 'manifest',
    });
    await expect(controller.checkGuardedTaskWriteOutcome('artifact')).rejects.toThrow(
      /different task operation/
    );
    await expect(
      controller.confirmGuardedTaskWriteOutcome(marker.attemptId, 'artifact')
    ).rejects.toThrow(/matching/);
    apiMock.teams.getTask.mockResolvedValueOnce({ ...task });
    await act(async () => {
      await controller.checkGuardedTaskWriteOutcome('manifest');
    });
    await expect(controller.confirmGuardedTaskWriteOutcome('wrong-id', 'manifest')).rejects.toThrow(
      /matching/
    );
    expect(
      await taskWriteGuardStorage.read({
        ...identity,
        dataRootFingerprint: guardContext.dataRootFingerprint,
      })
    ).toEqual(marker);
    await act(async () => {
      await controller.confirmGuardedTaskWriteOutcome(marker.attemptId, 'manifest');
    });
    expect(
      await taskWriteGuardStorage.read({
        ...identity,
        dataRootFingerprint: guardContext.dataRootFingerprint,
      })
    ).toBeNull();
  });

  it('fails closed if persistent safety storage is unavailable', async () => {
    const read = vi
      .spyOn(taskWriteGuardStorage, 'read')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await vi.waitFor(() =>
      expect(useStore.getState().taskDetailSessionById[key]?.taskWriteGuardState).toBe(
        'unavailable'
      )
    );
    const update = vi.fn(async () => undefined);
    useStore.setState({ updateTaskFields: update });
    await expect(controller.updateTaskArtifact({ artifactRequired: true })).rejects.toThrow(
      /No task write was sent/
    );
    expect(update).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('does not send a write if saving its persistent marker fails', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await waitForGuard();
    const acquire = vi
      .spyOn(taskWriteGuardStorage, 'acquire')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const update = vi.fn(async () => undefined);
    useStore.setState({ updateTaskFields: update });
    await act(async () => {
      await expect(controller.updateTaskArtifact({ artifactRequired: true })).rejects.toThrow(
        /safety storage/
      );
    });
    expect(update).not.toHaveBeenCalled();
    expect(useStore.getState().taskDetailSessionById[key].taskWriteGuardState).toBe('unavailable');
    acquire.mockRestore();
  });

  it('never clears an old-root marker after the active root changes', async () => {
    const marker = { version: 1 as const, attemptId: 'old-root', operation: 'artifact' as const };
    const guardIdentity = { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint };
    await taskWriteGuardStorage.acquire(guardIdentity, marker);
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await waitForGuard();
    apiMock.externalAgentConnection.getConnectionInfo.mockResolvedValue({
      context: { ...guardContext, dataRootFingerprint: 'b'.repeat(64), connectionGeneration: 2 },
      taskWriteRootFingerprint: 'b'.repeat(64),
    });
    await expect(controller.checkGuardedTaskWriteOutcome('artifact')).rejects.toThrow(
      /root changed/
    );
    expect(await taskWriteGuardStorage.read(guardIdentity)).toEqual(marker);
  });

  it('checks the same physical root after a generation-only settings change', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    const token = await makeUnknown(controller);
    const newContext = { ...guardContext, connectionGeneration: 2 };
    apiMock.externalAgentConnection.getConnectionInfo.mockResolvedValue({
      context: newContext,
      taskWriteRootFingerprint: guardContext.dataRootFingerprint,
    });
    apiMock.teams.getTask.mockResolvedValueOnce({ ...task });
    await act(async () => {
      await controller.checkGuardedTaskWriteOutcome('artifact');
      expect(useStore.getState().taskDetailSessionById[key].taskWriteExpectedContext).toEqual(
        newContext
      );
      await controller.confirmGuardedTaskWriteOutcome(token, 'artifact');
    });
    expect(
      await taskWriteGuardStorage.read({
        ...identity,
        dataRootFingerprint: guardContext.dataRootFingerprint,
      })
    ).toBeNull();
  });

  it.each([false, true])(
    'does not ask again after another window resolves a late ambiguous write (new marker: %s)',
    async (newMarker) => {
      let controller!: TaskDetailSessionController;
      await act(async () => {
        mount('dialog', (value) => {
          controller = value;
        });
      });
      await waitForGuard();
      let rejectWrite!: (reason: Error) => void;
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const update = vi.fn(() => {
        started();
        return new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        });
      });
      useStore.setState({ updateTaskFields: update });
      let pending!: Promise<void>;
      await act(async () => {
        pending = controller.updateTaskArtifact({ artifactRequired: true });
        await startedPromise;
      });
      const token = useStore.getState().taskDetailSessionById[key].artifactWriteId!;
      const guardIdentity = { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint };
      await taskWriteGuardStorage.release(
        guardIdentity,
        { version: 1, attemptId: token, operation: 'artifact' },
        { explicitDecision: true }
      );
      const next = {
        version: 1 as const,
        attemptId: 'next-manifest',
        operation: 'manifest' as const,
      };
      if (newMarker) await taskWriteGuardStorage.acquire(guardIdentity, next);
      await act(async () => {
        rejectWrite(new Error('late unknown'));
        await expect(pending).rejects.toThrow(/late unknown/);
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(controller.taskWriteGuard).toMatchObject({
        activeId: null,
        unknown: newMarker,
        markerId: newMarker ? next.attemptId : null,
        operation: newMarker ? 'manifest' : null,
      });
      expect(await taskWriteGuardStorage.read(guardIdentity)).toEqual(newMarker ? next : null);
    }
  );

  it('rehydrates independent markers when the same task id moves between roots and back', async () => {
    const rootB = { ...guardContext, dataRootFingerprint: 'b'.repeat(64), connectionGeneration: 3 };
    const identityA = { ...identity, dataRootFingerprint: guardContext.dataRootFingerprint };
    const identityB = { ...identity, dataRootFingerprint: rootB.dataRootFingerprint };
    await del(taskWriteGuardKey(identityB));
    let controller!: TaskDetailSessionController;
    let surface!: ReturnType<typeof createRoot>;
    await act(async () => {
      surface = mount('root-a', (value) => {
        controller = value;
      });
    });
    const tokenA = await makeUnknown(controller);

    const switchRoot = async (
      context: typeof guardContext,
      physicalRoot = context.dataRootFingerprint
    ): Promise<void> => {
      await act(async () => {
        surface.unmount();
        roots.splice(roots.indexOf(surface), 1);
        apiMock.externalAgentConnection.getConnectionInfo.mockResolvedValue({
          context,
          taskWriteRootFingerprint: physicalRoot,
        });
        resetWorkspaceForRootChange();
        useStore.setState({
          taskDetailById: {
            [key]: {
              ...createTaskDetailReadEntry(identity),
              phase: 'ready',
              full: task,
              loading: false,
            },
          },
          teamByName: { [identity.teamName]: teamSummary },
          teamDataCacheByName: { [identity.teamName]: teamSnapshot },
        });
        acceptLiveTeamSnapshotFixture(identity.teamName);
        surface = mount(`root-${context.connectionGeneration}`, (value) => {
          controller = value;
        });
      });
      await act(async () => {
        await waitForGuard();
      });
    };

    await switchRoot(
      { ...guardContext, dataRootFingerprint: 'c'.repeat(64), connectionGeneration: 2 },
      identityA.dataRootFingerprint
    );
    expect(controller.taskWriteGuard).toMatchObject({
      unknown: true,
      markerId: tokenA,
      expectedRootFingerprint: identityA.dataRootFingerprint,
    });

    await switchRoot(rootB);
    expect(controller.taskWriteGuard).toMatchObject({
      status: 'ready',
      unknown: false,
      markerId: null,
      expectedRootFingerprint: identityB.dataRootFingerprint,
    });
    let tokenB = '';
    await act(async () => {
      const attempt = await controller.beginGuardedTaskWrite('artifact');
      tokenB = attempt.token;
      expect(attempt.expectedRootFingerprint).toBe(identityB.dataRootFingerprint);
      await controller.settleGuardedTaskWrite(tokenB, 'artifact', 'unknown');
    });
    expect((await taskWriteGuardStorage.read(identityA))?.attemptId).toBe(tokenA);
    expect((await taskWriteGuardStorage.read(identityB))?.attemptId).toBe(tokenB);

    await switchRoot({ ...guardContext, connectionGeneration: 4 });
    expect(controller.taskWriteGuard).toMatchObject({ unknown: true, markerId: tokenA });
    apiMock.teams.getTask.mockResolvedValueOnce({ ...task });
    await act(async () => {
      await controller.checkGuardedTaskWriteOutcome('artifact');
      await controller.confirmGuardedTaskWriteOutcome(tokenA, 'artifact');
    });
    expect(await taskWriteGuardStorage.read(identityA)).toBeNull();
    expect((await taskWriteGuardStorage.read(identityB))?.attemptId).toBe(tokenB);
    await switchRoot({ ...rootB, connectionGeneration: 5 });
    expect(controller.taskWriteGuard).toMatchObject({ unknown: true, markerId: tokenB });
    await del(taskWriteGuardKey(identityB));
  });

  it('does not confirm a newer unknown outcome with an older in-flight read', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await makeUnknown(controller);
    let resolveRead!: (value: TeamTaskWithKanban) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    apiMock.teams.getTask.mockImplementationOnce(() => {
      signalStarted();
      return new Promise<TeamTaskWithKanban>((resolve) => {
        resolveRead = resolve;
      });
    });
    let checking!: Promise<void>;
    await act(async () => {
      checking = controller.checkArtifactOutcome();
      await started;
    });
    await act(async () => {
      controller.markArtifactOutcomeUnknown();
    });
    await act(async () => {
      resolveRead(task);
      await expect(checking).rejects.toThrow(/changed during the check/);
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
    expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeChecked).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let a late %s unlock a newer guarded write',
    async (lateResult) => {
      let controller!: TaskDetailSessionController;
      await act(async () => {
        mount('dialog', (value) => {
          controller = value;
        });
      });
      await waitForGuard();
      expect(controller.canEditNow()).toBe(true);
      let resolveWrite!: () => void;
      let rejectWrite!: (error: Error) => void;
      let resolveNext!: () => void;
      let firstStarted!: () => void;
      let nextStarted!: () => void;
      const firstStartedPromise = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const nextStartedPromise = new Promise<void>((resolve) => {
        nextStarted = resolve;
      });
      const update = vi
        .fn()
        .mockImplementationOnce(() => {
          firstStarted();
          return new Promise<void>((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
          });
        })
        .mockImplementationOnce(() => {
          nextStarted();
          return new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        });
      useStore.setState({ updateTaskFields: update });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let timedOut!: Promise<void>;
        await act(async () => {
          const operation = controller.updateTaskArtifact({ artifactRequired: true });
          timedOut = expect(operation).rejects.toThrow(/timed out/);
          await firstStartedPromise;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          await timedOut;
        });
      } finally {
        vi.useRealTimers();
      }
      expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(true);
      apiMock.teams.getTask.mockResolvedValueOnce({
        ...task,
        artifactRequirement: { required: true },
      });
      await act(async () => {
        await controller.checkArtifactOutcome();
      });
      await act(async () => {
        await controller.confirmArtifactOutcome();
      });
      expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(false);
      let next!: Promise<void>;
      await act(async () => {
        next = controller.updateTaskArtifact({ artifactRequired: true });
        await nextStartedPromise;
      });
      const nextId = useStore.getState().taskDetailSessionById[key].artifactWriteId;
      expect(nextId).toBeTruthy();
      await act(async () => {
        if (lateResult === 'resolve') resolveWrite();
        else rejectWrite(new Error('late failure'));
        await Promise.resolve();
      });
      expect(update).toHaveBeenCalledTimes(2);
      expect(useStore.getState().taskDetailSessionById[key].artifactWriteId).toBe(nextId);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
      expect(useStore.getState().taskDetailSessionById[key].artifactOutcomeUnknown).toBe(false);
      apiMock.teams.getTask.mockResolvedValueOnce({
        ...task,
        artifactRequirement: { required: true },
      });
      await act(async () => {
        resolveNext();
        await next;
      });
      expect(useStore.getState().taskDetailSessionById[key].artifactWriteId).toBeNull();
    }
  );

  it('keeps an in-flight guard when the task surface unmounts and reopens', async () => {
    let first!: TaskDetailSessionController;
    let root!: ReturnType<typeof createRoot>;
    await act(async () => {
      root = mount('dialog-a', (value) => {
        first = value;
      });
    });
    await waitForGuard();
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const update = vi.fn(() => {
      started();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    useStore.setState({ updateTaskFields: update });
    let pending!: Promise<void>;
    await act(async () => {
      pending = first.updateTaskArtifact({ artifactRequired: true });
      await startedPromise;
    });
    const attemptId = useStore.getState().taskDetailSessionById[key].artifactWriteId;
    let reopened!: TaskDetailSessionController;
    await act(async () => {
      root.unmount();
      roots.splice(roots.indexOf(root), 1);
      mount('dialog-b', (value) => {
        reopened = value;
      });
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactWriteId).toBe(attemptId);
    await expect(reopened.updateTaskArtifact({ artifactRequired: true })).rejects.toThrow(
      /No task write was sent/
    );
    expect(update).toHaveBeenCalledTimes(1);
    apiMock.teams.getTask.mockResolvedValueOnce({
      ...task,
      artifactRequirement: { required: true },
    });
    await act(async () => {
      finish();
      await pending;
    });
    expect(useStore.getState().taskDetailSessionById[key].artifactWriteId).toBeNull();
  });

  it('refreshes same-ID tasks across teams once per identity from root interest', async () => {
    const other = { ...identity, teamName: 'TEST-other-team' };
    const otherKey = taskDetailKey(other);
    const tails = new Map([
      [identity.teamName, 'full tail A'],
      [other.teamName, 'full tail B'],
    ]);
    apiMock.teams.getTask.mockImplementation(async (teamName: string) => ({
      ...task,
      description: tails.get(teamName),
    }));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      useStore.setState({ taskDetailById: {} });
      useStore.getState().openTaskDetailTab(identity);
      useStore.getState().openTaskDetailTab(other);
      useStore.getState().setTaskDetailSurfaceInterest('duplicate-dialog', identity);
      root.render(React.createElement(TaskDetailReadCoordinator));
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(2);
    expect(useStore.getState().taskDetailById[key].full?.description).toBe('full tail A');
    expect(useStore.getState().taskDetailById[otherKey].full?.description).toBe('full tail B');

    tails.set(identity.teamName, 'changed tail A');
    tails.set(other.teamName, 'changed tail B');
    await act(async () => {
      useStore.getState().invalidateTaskDetailTeamSource('local', identity.teamName, '1');
      useStore.getState().invalidateTaskDetailTeamSource('local', other.teamName, '1');
    });
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(4);
    expect(useStore.getState().taskDetailById[key].full?.description).toBe('changed tail A');
    expect(useStore.getState().taskDetailById[otherKey].full?.description).toBe('changed tail B');
    await act(async () => {
      useStore.getState().setTaskDetailSurfaceInterest('duplicate-dialog', null);
      useStore.setState({ selectedProjectId: 'TEST-unrelated-selection' });
    });
    expect(useStore.getState().taskDetailSurfaceInterests).not.toHaveProperty('duplicate-dialog');
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(4);
  });

  it('keeps refused reviews and ignores a late confirmation for an older nonce', async () => {
    let first!: (accepted: boolean) => void;
    let second!: (accepted: boolean) => void;
    const openReview = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            first = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            second = resolve;
          })
      )
      .mockResolvedValue(true);
    useStore.setState({
      selectTeam: vi.fn(async (teamName: string) => {
        useStore.setState({ selectedTeamName: teamName });
      }),
    });
    useStore.getState().updateTaskDetailSessionPart(identity, 'commentText', 'keep route draft');
    expect(useStore.getState().openTaskDetailReview(identity, { requestOptions: {} })).toBe(true);
    const targetId = useStore.getState().pendingReviewRequest!.targetTeamTabId;
    const firstNonce = useStore.getState().pendingReviewRequest!.nonce;
    const Target = ({ teamName }: { teamName: string }) => {
      useTaskDetailReviewRoute({
        teamName,
        tabId: targetId,
        active: true,
        ready: true,
        openReview,
      });
      return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      // TeamDetailView consumes only after its target team data is selected.
      useStore.setState({ selectedTeamName: identity.teamName });
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Target, { teamName: 'TEST-wrong-team' }),
          React.createElement(Target, { teamName: identity.teamName })
        )
      );
    });
    expect(openReview).toHaveBeenCalledTimes(1);
    expect(useStore.getState().pendingReviewRequest?.status).toBe('opening');
    await act(async () => {
      useStore
        .getState()
        .openTaskDetailReview(identity, { filePath: 'next.ts', requestOptions: {} });
    });
    const secondNonce = useStore.getState().pendingReviewRequest!.nonce;
    expect(secondNonce).not.toBe(firstNonce);
    await act(async () => {
      first(true);
    });
    expect(useStore.getState().pendingReviewRequest?.nonce).toBe(secondNonce);
    await act(async () => {
      second(false);
    });
    expect(useStore.getState().pendingReviewRequest?.status).toBe('blocked');
    expect(useStore.getState().pendingReviewRequest?.nonce).toBe(secondNonce);
    await act(async () => {
      useStore.getState().retryPendingTaskDetailReview(secondNonce);
    });
    expect(openReview).toHaveBeenCalledTimes(3);
    expect(useStore.getState().pendingReviewRequest).toBeNull();
    expect(useStore.getState().taskDetailSessionById[key].commentText).toBe('keep route draft');
    await act(async () => {
      useStore.getState().openTaskDetailTab(identity);
      useStore.setState({ setActiveTab: vi.fn() });
      expect(useStore.getState().openTaskDetailReview(identity, { requestOptions: {} })).toBe(
        false
      );
    });
    expect(useStore.getState().pendingReviewRequest).toBeNull();
    expect(useStore.getState().taskDetailReviewActivationFailure?.identity).toEqual(identity);
    useStore
      .getState()
      .closeTaskDetailReviewActivationFailure(
        useStore.getState().taskDetailReviewActivationFailure!.nonce
      );
    expect(useStore.getState().taskDetailReviewActivationFailure).toBeNull();
  });

  it('addresses editor requests to one host and keeps blocked or retired requests inert', async () => {
    const projectPath = '/TEST/editor-project';
    const intent = { projectPath, filePath: `${projectPath}/README.md`, line: 7 };
    const openEditor = vi.fn();
    const wrongEditor = vi.fn();
    const reveal = vi.fn();
    useStore.setState({
      selectTeam: vi.fn(async () => {}),
      editorProjectPath: projectPath,
      editorFileTree: [],
      editorFileTreeLoading: true,
      editorFileTreeError: null,
      revealFileInEditor: reveal,
    });
    expect(useStore.getState().openTaskDetailEditor(identity, intent)).toBe(true);
    const request = useStore.getState().pendingTaskDetailEditorRequest!;
    const Host = ({ wrong = false }: { wrong?: boolean }) => {
      useTaskDetailEditorHost({
        teamName: wrong ? 'TEST-other-team' : identity.teamName,
        tabId: wrong ? 'TEST-other-tab' : request.targetTeamTabId,
        active: true,
        projectPath,
        openEditor: wrong ? wrongEditor : openEditor,
      });
      return null;
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(Host),
          React.createElement(Host, { wrong: true })
        )
      );
    });
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(wrongEditor).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => {
      useStore.setState({ editorFileTreeError: 'TEST unavailable' });
    });
    expect(useStore.getState().pendingTaskDetailEditorRequest?.status).toBe('blocked');
    await act(async () => {
      useStore.setState({ editorFileTreeError: null, editorFileTreeLoading: false });
    });
    expect(reveal).not.toHaveBeenCalled();
    await act(async () => {
      expect(useStore.getState().retryPendingTaskDetailEditor(request.nonce)).toBe(true);
    });
    expect(reveal).toHaveBeenCalledExactlyOnceWith(intent.filePath);
    expect(useStore.getState().editorPendingGoToLine).toBe(7);
    expect(useStore.getState().pendingTaskDetailEditorRequest).toBeNull();
    await act(async () => {
      useStore.setState({ editorFileTreeLoading: true });
      useStore.getState().openTaskDetailEditor(identity, intent);
    });
    const retired = useStore.getState().pendingTaskDetailEditorRequest!;
    invalidateContextScopedRequestEpoch();
    expect(useStore.getState().retryPendingTaskDetailEditor(retired.nonce)).toBe(false);
    await act(async () => {
      useStore.setState({ editorFileTreeLoading: false });
    });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(wrongEditor).not.toHaveBeenCalled();
  });

  it('shows a refused editor activation only in its originating task', async () => {
    const other = { ...identity, taskId: '2' };
    const intent = { projectPath: '/TEST/project', filePath: '/TEST/project/a.ts', line: null };
    useStore.setState({ openTeamTab: vi.fn() });
    expect(useStore.getState().openTaskDetailEditor(identity, intent)).toBe(false);
    const nonce = useStore.getState().taskDetailEditorActivationFailure!.nonce;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { 'data-source': '1' },
            React.createElement(TaskDetailEditorActivationFeedback, { identity, active: true })
          ),
          React.createElement(
            'div',
            { 'data-source': '2' },
            React.createElement(TaskDetailEditorActivationFeedback, {
              identity: other,
              active: true,
            })
          )
        )
      );
    });
    expect(host.querySelector('[data-source="1"] button')).not.toBeNull();
    expect(host.querySelector('[data-source="2"]')?.textContent).toBe('');
    await act(async () => {
      expect(useStore.getState().openTaskDetailEditor(other, intent)).toBe(false);
    });
    expect(useStore.getState().retryTaskDetailEditorActivationFailure(nonce)).toBe(false);
    expect(host.querySelector('[data-source="1"]')?.textContent).toBe('');
    expect(host.querySelector('[data-source="2"] button')).not.toBeNull();
  });

  it('continues a FileReader after dialog unmount and does not read a removed queued file', async () => {
    const readers: DeferredReader[] = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        readers.push(this);
      }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    let source!: TaskDetailSessionController;
    let target!: TaskDetailSessionController;
    let successor!: TaskDetailSessionController;
    let targetRoot!: ReturnType<typeof createRoot>;
    let sourceRoot!: ReturnType<typeof createRoot>;
    await act(async () => {
      sourceRoot = mount('dialog', (value) => {
        source = value;
      });
    });
    let reading!: Promise<void>;
    await act(async () => {
      reading = source.addPendingFiles([
        new File(['hello'], 'keep.txt', { type: 'text/plain' }),
        new File(['world'], 'remove.txt', { type: 'text/plain' }),
      ]);
    });
    expect(source.canSubmit).toBe(false);
    expect(source.session.pendingAttachments.map((file) => file.filename)).toEqual([
      'keep.txt',
      'remove.txt',
    ]);
    await act(async () => {
      expect(source.openInTaskTab()).toBe(true);
    });
    const tabId = useStore.getState().taskDetailSessionById[key].ownerSurfaceId!;
    await act(async () => {
      sourceRoot.unmount();
      roots.splice(roots.indexOf(sourceRoot), 1);
      targetRoot = mount(tabId, (value) => {
        target = value;
      });
    });
    expect(target.isOwner).toBe(true);
    const removed = target.session.pendingAttachments.find(
      (file) => file.filename === 'remove.txt'
    )!;
    await act(async () => {
      target.removePendingAttachment(removed.id);
    });
    await act(async () => {
      readers[0].result = 'data:text/plain;base64,aGVsbG8=';
      readers[0].onload?.();
      await reading;
    });
    expect(readers).toHaveLength(1);
    expect(target.session.pendingAttachments).toMatchObject([
      { filename: 'keep.txt', base64Data: 'aGVsbG8=', size: 5 },
    ]);
    expect(target.session.ownerSurfaceId).toBe(tabId);
    expect(target.session.pendingAttachmentPreparationIds).toEqual([]);
    await act(async () => {
      mount('successor', (value) => {
        successor = value;
      });
    });
    expect(successor.isOwner).toBe(false);
    await act(async () => {
      targetRoot.unmount();
      roots.splice(roots.indexOf(targetRoot), 1);
    });
    expect(successor.isOwner).toBe(true);
  });

  it('rejects edits after delete acceptance while the successor refresh is pending', async () => {
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    await act(async () => controller.setCommentText('TEST preserved deletion draft'));
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    apiMock.teams.softDeleteTask.mockResolvedValue(undefined);
    await act(async () => {
      useStore.setState({
        refreshTeamData: vi.fn(() => refresh),
        fetchDeletedTasks: vi.fn(async () => {}),
      });
    });
    let deleting!: Promise<void>;
    await act(async () => {
      deleting = useStore.getState().softDeleteTask(identity.teamName, identity.taskId);
    });
    expect(useStore.getState().refreshTeamData).toHaveBeenCalledTimes(1);
    expect(useStore.getState().taskDetailById[key].full?.status).toBe('pending');
    const canEditAfterDeleteAcceptance = controller.canEditNow();
    await act(async () => {
      finishRefresh();
      await deleting;
    });
    expect(controller.session.commentText).toBe('TEST preserved deletion draft');
    expect(canEditAfterDeleteAcceptance).toBe(false);
  });

  it('finishes a selected file in its own draft across context changes and honors removal', async () => {
    const readers: { result: string | null; onload: (() => void) | null }[] = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        readers.push(this);
      }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    let controller!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
    });
    let reading!: Promise<void>;
    await act(async () => {
      reading = controller.addPendingFiles([
        new File(['hello'], 'keep.txt', { type: 'text/plain' }),
        new File(['world'], 'remove.txt', { type: 'text/plain' }),
      ]);
    });
    await act(async () => {
      controller.removePendingAttachment(controller.session.pendingAttachments[1].id);
      useStore.getState().retireTaskDetailSessionWork();
      invalidateContextScopedRequestEpoch();
      useStore.setState({ activeContextId: 'TEST-context-B' });
    });
    await act(async () => {
      readers[0].result = 'data:text/plain;base64,aGVsbG8=';
      readers[0].onload?.();
      await reading;
      invalidateContextScopedRequestEpoch();
      useStore.setState({ activeContextId: identity.contextId });
    });
    expect(controller.session.pendingAttachments).toMatchObject([
      {
        filename: 'keep.txt',
        base64Data: 'aGVsbG8=',
        previewUrl: 'data:text/plain;base64,aGVsbG8=',
      },
    ]);
    expect(controller.session.pendingAttachmentPreparationIds).toEqual([]);
    expect(readers).toHaveLength(1);
    expect(apiMock.teams.addTaskComment).not.toHaveBeenCalled();
  });

  it('makes deleted-team task details unavailable while preserving drafts and the other team', async () => {
    let controller!: TaskDetailSessionController;
    const other = { ...identity, teamName: 'TEST-independent-team' };
    const otherKey = taskDetailKey(other);
    await act(async () => {
      mount('dialog', (value) => {
        controller = value;
      });
      useStore.setState((state) => ({
        taskDetailById: {
          ...state.taskDetailById,
          [otherKey]: { ...createTaskDetailReadEntry(other), phase: 'ready', full: task },
        },
      }));
    });
    await act(async () => {
      controller.setCommentText('TEST draft survives unavailable team');
      useStore.setState({
        teamByName: {
          [identity.teamName]: { ...teamSummary, deletedAt: teamDeletedAt },
        },
        teamDataCacheByName: {
          [identity.teamName]: {
            ...teamSnapshot,
            config: { ...teamSnapshot.config, deletedAt: teamDeletedAt },
          },
        },
      });
      useStore.getState().clearDeletedTeamLocalState(identity.teamName);
    });
    // Soft-deleting a team retains its physical task JSON. A successor full
    // read must not turn that retained task back into an editable live task.
    apiMock.teams.getTask.mockResolvedValue({ ...task });
    await act(async () => {
      await useStore.getState().ensureTaskDetail(identity);
    });
    expect(controller.session.commentText).toBe('TEST draft survives unavailable team');
    expect(useStore.getState().taskDetailById[otherKey].phase).toBe('ready');
    expect(useStore.getState().taskDetailById[key].phase).toBe('unavailable');
    expect(controller.canEditNow()).toBe(false);
    expect(apiMock.teams.addTaskComment).not.toHaveBeenCalled();

    await act(async () => {
      useStore.setState({ taskDetailById: {} });
      await useStore.getState().ensureTaskDetail(identity);
    });
    expect(useStore.getState().taskDetailById[key].phase).toBe('unavailable');
    expect(controller.canEditNow()).toBe(false);
    expect(apiMock.teams.getTask).not.toHaveBeenCalled();

    apiMock.teams.restoreTeam.mockResolvedValue(undefined);
    useStore.setState({
      refreshTeamData: vi.fn(async () => {
        useStore.setState({
          teamByName: { [identity.teamName]: teamSummary },
          teamDataCacheByName: { [identity.teamName]: teamSnapshot },
        });
        acceptLiveTeamSnapshotFixture(identity.teamName);
      }),
      fetchTeams: vi.fn(async () => {}),
      fetchAllTasks: vi.fn(async () => {}),
    });
    await act(async () => {
      await useStore.getState().restoreTeam(identity.teamName);
      await useStore.getState().ensureTaskDetail(identity);
    });
    expect(apiMock.teams.restoreTeam).toHaveBeenCalledWith(identity.teamName);
    expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
    expect(useStore.getState().taskDetailById[key].phase).toBe('ready');
    expect(controller.session.commentText).toBe('TEST draft survives unavailable team');
    expect(controller.canEditNow()).toBe(true);
  });

  it.each(['success', 'failure'] as const)(
    'retires a pending submit after a same-team epoch reset before its late %s',
    async (outcome) => {
      let controller!: TaskDetailSessionController;
      await act(async () => {
        mount('dialog', (value) => {
          controller = value;
        });
      });
      await act(async () => controller.setCommentText('TEST draft survives team reset'));
      const other = { ...identity, teamName: 'TEST-independent-team' };
      const otherKey = taskDetailKey(other);
      await act(async () => {
        useStore.setState((state) => ({
          taskDetailById: {
            ...state.taskDetailById,
            [otherKey]: {
              ...createTaskDetailReadEntry(other),
              phase: 'ready',
              full: task,
              loading: false,
            },
          },
        }));
        useStore.getState().updateTaskDetailSessionPart(other, 'commentText', 'TEST B independent');
        useStore.getState().beginTaskDetailSubmitSession(other);
      });
      let resolve!: (comment: TaskComment) => void;
      let reject!: (error: Error) => void;
      apiMock.teams.addTaskComment.mockReturnValue(
        new Promise<TaskComment>((accept, fail) => {
          resolve = accept;
          reject = fail;
        })
      );
      let submitting!: Promise<void>;
      await act(async () => {
        submitting = controller.submitComment();
      });
      expect(useStore.getState().taskDetailSessionById[key].submitPending).toBe(true);
      await act(async () => {
        useStore.getState().clearDeletedTeamLocalState(identity.teamName);
      });
      await act(async () => {
        if (outcome === 'failure') reject(new Error('TEST retired request failure'));
        else
          resolve({
            id: 'retired-comment',
            author: 'user',
            text: 'TEST draft survives team reset',
            createdAt: '2026-10-14T00:00:00Z',
            type: 'regular',
          });
        await submitting;
      });
      if (outcome === 'failure') {
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toBe(
          '[Renderer:unwrapIpc] [team:addTaskComment] TEST retired request failure'
        );
        vi.mocked(console.error).mockClear();
      }
      expect(useStore.getState().taskDetailSessionById[key]).toMatchObject({
        commentText: 'TEST draft survives team reset',
        submitPending: false,
        submitError: null,
      });
      expect(useStore.getState().taskDetailSessionById[otherKey]).toMatchObject({
        commentText: 'TEST B independent',
        submitPending: true,
      });
      expect(useStore.getState().refreshTeamData).not.toHaveBeenCalled();
      expect(apiMock.teams.addTaskComment).toHaveBeenCalledTimes(1);
      // A retained ready DTO cannot restore a deleted team's permissions.
      await act(async () => {
        useStore.setState((state) => ({
          taskDetailById: {
            ...state.taskDetailById,
            [key]: { ...createTaskDetailReadEntry(identity), phase: 'ready', full: task },
          },
        }));
      });
      expect(controller.canSubmit).toBe(false);
      apiMock.teams.restoreTeam.mockResolvedValue(undefined);
      apiMock.teams.getTask.mockResolvedValue({ ...task });
      useStore.setState({
        refreshTeamData: vi.fn(async () => {
          useStore.setState({
            teamByName: { [identity.teamName]: teamSummary },
            teamDataCacheByName: { [identity.teamName]: teamSnapshot },
          });
          acceptLiveTeamSnapshotFixture(identity.teamName);
        }),
        fetchTeams: vi.fn(async () => {}),
        fetchAllTasks: vi.fn(async () => {}),
      });
      await act(async () => {
        await useStore.getState().restoreTeam(identity.teamName);
        await useStore.getState().ensureTaskDetail(identity);
      });
      expect(apiMock.teams.restoreTeam).toHaveBeenCalledWith(identity.teamName);
      expect(apiMock.teams.getTask).toHaveBeenCalledTimes(1);
      expect(controller.canSubmit).toBe(true);
    }
  );

  it('keeps a refused handoff and prevents a late submit from changing another context', async () => {
    let source!: TaskDetailSessionController;
    let peer!: TaskDetailSessionController;
    await act(async () => {
      mount('dialog', (value) => {
        source = value;
      });
      mount('peer', (value) => {
        peer = value;
      });
    });
    expect(source.isOwner).toBe(true);
    expect(peer.isOwner).toBe(false);
    await act(async () => {
      source.setCommentText('keep A');
      peer.setCommentText('wrong peer');
    });
    let ordinaryTabId!: string;
    let targetTabId!: string;
    await act(async () => {
      useStore.getState().openTab({ type: 'settings', label: 'TEST settings' });
      ordinaryTabId = useStore.getState().activeTabId!;
      targetTabId = useStore.getState().openTaskDetailTab(identity)!.tabId;
      useStore.getState().setActiveTab(ordinaryTabId);
      useStore.setState({ setActiveTab: vi.fn() });
    });
    await act(async () => {
      expect(source.openInTaskTab()).toBe(false);
    });
    expect(useStore.getState().taskDetailSessionById[key].ownerSurfaceId).toBe('dialog');
    expect(useStore.getState().taskDetailSessionById[key].commentText).toBe('keep A');
    expect(targetTabId).not.toBe(ordinaryTabId);

    let finish!: (comment: TaskComment) => void;
    apiMock.teams.addTaskComment.mockReturnValue(
      new Promise<TaskComment>((resolve) => {
        finish = resolve;
      })
    );
    let submitting!: Promise<void>;
    await act(async () => {
      submitting = source.submitComment();
    });
    const other = { ...identity, contextId: 'remote-test' };
    const otherKey = taskDetailKey(other);
    await act(async () => {
      useStore.getState().retireTaskDetailSessionWork();
      invalidateContextScopedRequestEpoch();
      useStore.setState({ activeContextId: other.contextId });
      useStore.getState().updateTaskDetailSessionPart(other, 'commentText', 'keep B');
      useStore.getState().beginTaskDetailSubmitSession(other);
      useStore.setState({ addingComment: true, addCommentError: 'B error' });
    });
    await act(async () => {
      finish({
        id: 'comment-1',
        author: 'user',
        text: 'keep A',
        createdAt: '2026-10-14T00:00:00Z',
        type: 'regular',
      });
      await submitting;
    });
    const state = useStore.getState();
    expect(state.taskDetailSessionById[otherKey]).toMatchObject({
      commentText: 'keep B',
      submitPending: true,
    });
    expect(state.taskDetailSessionById[key]).toMatchObject({
      commentText: 'keep A',
      submitPending: false,
    });
    expect(state.addingComment).toBe(true);
    expect(state.addCommentError).toBe('B error');
    expect(state.refreshTeamData).not.toHaveBeenCalled();
  });
});
