import 'fake-indexeddb/auto';

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { del } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  resolve: vi.fn(),
  confirm: vi.fn(),
  state: { activeContextId: 'local', isContextSwitching: false },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state,
    }
  ),
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      inspectPendingKanbanTransition: mocks.inspect,
      resolvePendingKanbanTransition: mocks.resolve,
    },
  },
}));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: mocks.confirm }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

const { TeamReviewRecovery } = await import('@renderer/components/team/TeamReviewRecovery');
const {
  kanbanRecoveryDecisionStorage,
  kanbanRecoveryDecisionKey,
  createKanbanRecoveryDecisionStorage,
} = await import('@renderer/components/team/kanbanRecoveryDecision');
const { invalidateContextScopedRequestEpoch } =
  await import('@renderer/store/utils/contextScopedRequestEpoch');
interface FixtureController {
  taskBoard: {
    createTask(input: object): { id: string };
    completeTask(id: string, actor: string): unknown;
    addReviewer(name: string): unknown;
    requestReview(id: string, options: object): unknown;
    startTask(id: string, actor: string): unknown;
    getTask(id: string): { pendingKanbanTransition?: unknown };
  };
  kanban: {
    inspectPendingTransition(id: string): PendingKanbanTransitionSnapshot;
    resolvePendingTransition(
      id: string,
      transitionId: string,
      snapshotHash: string | undefined,
      mode: string,
      contextHash: string
    ): void;
  };
}
const rawFs = createRequire(import.meta.url)('node:fs') as typeof fs;
const { createController } = createRequire(import.meta.url)(
  '../../../../agent-teams-controller/src/index.js'
) as { createController: (config: object) => FixtureController };
const spyOnRead = () => vi.spyOn(kanbanRecoveryDecisionStorage, 'read');
const spyOnClaim = () => vi.spyOn(kanbanRecoveryDecisionStorage, 'claim');
const spyOnTransition = () => vi.spyOn(kanbanRecoveryDecisionStorage, 'transition');

describe('Kanban recovery across independent panels', () => {
  let fixture: string;
  let taskId: string;
  let controller: FixtureController;
  let hostA: HTMLDivElement;
  let hostB: HTMLDivElement;
  let rootA: Root;
  let rootB: Root;
  let snapshots: PendingKanbanTransitionSnapshot[];
  let read: ReturnType<typeof spyOnRead>;
  let claim: ReturnType<typeof spyOnClaim>;
  let transition: ReturnType<typeof spyOnTransition>;

  const error = () =>
    `KANBAN_TRANSITION_UNCERTAIN: Task status transition for task ${taskId} has an unknown outcome`;
  const confirmButton = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'artifact.recoveryConfirm'
    );
  const makePendingStart = () => {
    const boardPath = path.join(fixture, 'teams', 'fixture', 'kanban-state.json');
    const rename = rawFs.renameSync;
    const spy = vi.spyOn(rawFs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === boardPath)
        throw Object.assign(new Error('board EIO'), { code: 'EIO' });
      return rename(source, destination);
    });
    try {
      expect(() => controller.taskBoard.startTask(taskId, 'worker')).toThrow(/unknown outcome/);
    } finally {
      spy.mockRestore();
    }
  };
  const renderPanels = async () => {
    await act(async () => {
      rootA.render(
        <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={() => {}} />
      );
      rootB.render(
        <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={() => {}} />
      );
    });
  };
  const inspectBoth = async () => {
    await act(async () => {
      hostA.querySelector('button')!.click();
      hostB.querySelector('button')!.click();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      await Promise.all(read.mock.results.map((result) => result.value));
    });
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    mocks.state.activeContextId = 'local';
    mocks.state.isContextSwitching = false;
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-recovery-panels-'));
    const teamDir = path.join(fixture, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    controller = createController({ teamName: 'fixture', claudeDir: fixture });
    const task = controller.taskBoard.createTask({ subject: 'Target', owner: 'worker' });
    taskId = task.id;
    controller.taskBoard.completeTask(taskId, 'worker');
    controller.taskBoard.addReviewer('lead');
    controller.taskBoard.requestReview(taskId, { from: 'worker', reviewer: 'lead' });
    makePendingStart();
    snapshots = [];
    mocks.inspect.mockImplementation(async () => {
      const result = controller.kanban.inspectPendingTransition(
        taskId
      ) as PendingKanbanTransitionSnapshot;
      snapshots.push(result);
      return result;
    });
    mocks.resolve.mockImplementation(
      async (_team: string, _task: string, snapshot: PendingKanbanTransitionSnapshot) =>
        controller.kanban.resolvePendingTransition(
          taskId,
          snapshot.transitionId,
          snapshot.snapshotHash,
          snapshot.mode,
          snapshot.contextHash
        )
    );
    mocks.confirm.mockResolvedValue(true);
    read = spyOnRead();
    claim = spyOnClaim();
    transition = spyOnTransition();
    hostA = document.createElement('div');
    hostB = document.createElement('div');
    document.body.append(hostA, hostB);
    rootA = createRoot(hostA);
    rootB = createRoot(hostB);
  });

  afterEach(async () => {
    await act(async () => {
      rootA.unmount();
      rootB.unmount();
    });
    hostA.remove();
    hostB.remove();
    read.mockRestore();
    claim.mockRestore();
    transition.mockRestore();
    await Promise.all(snapshots.map((snapshot) => del(kanbanRecoveryDecisionKey(snapshot))));
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(fixture);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('kanban-recovery-panels-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    vi.unstubAllGlobals();
  });

  it('does not ask or dispatch again from a stale second panel after success', async () => {
    await renderPanels();
    await inspectBoth();
    const secondButton = confirmButton(hostB)!;
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
      await transition.mock.results[1].value;
    });
    await act(async () => {
      secondButton.click();
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
      await claim.mock.results[1].value;
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
    expect(hostB.textContent).toContain('artifact.recoveryDecisionConfirmed');
    expect(controller.taskBoard.getTask(taskId).pendingKanbanTransition).toBeUndefined();
  });

  it('atomically allows only one simultaneous question in two panels', async () => {
    let answer!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      })
    );
    await renderPanels();
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      confirmButton(hostB)!.click();
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
      await Promise.all(claim.mock.results.map((result) => result.value));
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    await act(async () => {
      answer(true);
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
      await transition.mock.results[1].value;
    });
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it('records a decline and never asks or sends from the other panel', async () => {
    mocks.confirm.mockResolvedValue(false);
    await renderPanels();
    await inspectBoth();
    const secondButton = confirmButton(hostB)!;
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce());
      await transition.mock.results[0].value;
    });
    await act(async () => {
      secondButton.click();
      await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
      await claim.mock.results[1].value;
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(hostB.textContent).toContain('artifact.recoveryDecisionDeclined');
  });

  it('keeps a lost result blocked after a panel restart', async () => {
    mocks.resolve.mockRejectedValue(new Error('transport timeout'));
    await renderPanels();
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
      await mocks.resolve.mock.results[0].value.catch(() => undefined);
    });
    await act(async () => {
      rootB.unmount();
      rootB = createRoot(hostB);
      rootB.render(
        <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={() => {}} />
      );
    });
    await act(async () => {
      hostB.querySelector('button')!.click();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      await read.mock.results[2].value;
    });
    expect(hostB.textContent).toContain('artifact.recoveryDecisionPending');
    expect(confirmButton(hostB)).toBeUndefined();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it('does not send a confirmed decision after an A-B-A context switch', async () => {
    let answer!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      })
    );
    await renderPanels();
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    });
    mocks.state.activeContextId = 'other';
    invalidateContextScopedRequestEpoch();
    mocks.state.activeContextId = 'local';
    invalidateContextScopedRequestEpoch();
    await act(async () => {
      answer(true);
      await vi.waitFor(() => expect(transition).toHaveBeenCalledOnce());
      await transition.mock.results[0].value;
    });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('not_sent');
  });

  it('keeps a new operation independent when the old response arrives late', async () => {
    let deliverOldResponse!: () => void;
    mocks.resolve.mockImplementationOnce(
      async (_team: string, _task: string, snapshot: PendingKanbanTransitionSnapshot) => {
        controller.kanban.resolvePendingTransition(
          taskId,
          snapshot.transitionId,
          snapshot.snapshotHash,
          snapshot.mode,
          snapshot.contextHash
        );
        await new Promise<void>((resolve) => {
          deliverOldResponse = resolve;
        });
      }
    );
    await renderPanels();
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledOnce());
    });
    controller.taskBoard.completeTask(taskId, 'worker');
    controller.taskBoard.requestReview(taskId, { from: 'worker', reviewer: 'lead' });
    makePendingStart();
    await act(async () => {
      hostB.querySelector('button')!.click();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      await read.mock.results[2].value;
    });
    expect(snapshots[2].transitionId).not.toBe(snapshots[0].transitionId);
    await act(async () => {
      deliverOldResponse();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
      await transition.mock.results[1].value;
    });
    expect(controller.kanban.inspectPendingTransition(taskId).transitionId).toBe(
      snapshots[2].transitionId
    );
    expect(await kanbanRecoveryDecisionStorage.read(snapshots[2])).toBeNull();
    expect(confirmButton(hostB)).toBeDefined();
    await act(async () => {
      confirmButton(hostB)!.click();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(4));
      await transition.mock.results[3].value;
    });
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(controller.taskBoard.getTask(taskId).pendingKanbanTransition).toBeUndefined();
  });

  it('offers a manual reload for a stale review inspection without inferring success', async () => {
    const previous = controller.kanban.inspectPendingTransition(taskId);
    controller.kanban.resolvePendingTransition(
      taskId,
      previous.transitionId,
      previous.snapshotHash,
      previous.mode,
      previous.contextHash
    );
    controller.taskBoard.completeTask(taskId, 'worker');
    const boardPath = path.join(fixture, 'teams', 'fixture', 'kanban-state.json');
    const rename = rawFs.renameSync;
    const spy = vi.spyOn(rawFs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === boardPath)
        throw Object.assign(new Error('board EIO'), { code: 'EIO' });
      return rename(source, destination);
    });
    try {
      expect(() =>
        controller.taskBoard.requestReview(taskId, { from: 'worker', reviewer: 'lead' })
      ).toThrow(/unknown outcome/);
    } finally {
      spy.mockRestore();
    }
    const reviewError = `KANBAN_TRANSITION_UNCERTAIN: Review transition for task ${taskId} has an unknown outcome`;
    const reload = vi.fn();
    await act(async () => {
      rootA.render(
        <TeamReviewRecovery teamName="fixture" error={reviewError} onRecovered={() => {}} />
      );
      rootB.render(
        <TeamReviewRecovery teamName="fixture" error={reviewError} onRecovered={reload} />
      );
    });
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
      await transition.mock.results[1].value;
    });
    await act(async () => {
      hostB.querySelector('button')!.click();
      await mocks.inspect.mock.results[2].value.catch(() => undefined);
    });
    expect(hostB.textContent).toContain('artifact.recoveryFailed');
    expect(hostB.textContent).toContain('artifact.recoveryReload');
    expect(hostB.textContent).not.toContain('artifact.recoveryDecisionConfirmed');
    expect(reload).not.toHaveBeenCalled();
    const reloadButton = Array.from(hostB.querySelectorAll('button')).find(
      (button) => button.textContent === 'artifact.recoveryReload'
    )!;
    await act(async () => reloadButton.click());
    expect(reload).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it('reports an unresponsive recovery after 30 seconds and isolates a late success from a new operation', async () => {
    let deliverOldResponse!: () => void;
    let notifyDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      notifyDispatched = resolve;
    });
    mocks.resolve.mockImplementationOnce(
      async (_team: string, _task: string, snapshot: PendingKanbanTransitionSnapshot) => {
        controller.kanban.resolvePendingTransition(
          taskId,
          snapshot.transitionId,
          snapshot.snapshotHash,
          snapshot.mode,
          snapshot.contextHash
        );
        notifyDispatched();
        await new Promise<void>((resolve) => {
          deliverOldResponse = resolve;
        });
      }
    );
    const reload = vi.fn();
    await act(async () => {
      rootA.render(<TeamReviewRecovery teamName="fixture" error={error()} onRecovered={reload} />);
      rootB.render(
        <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={() => {}} />
      );
    });
    await inspectBoth();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        confirmButton(hostA)!.click();
        await dispatched;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(hostA.textContent).toContain('artifact.recoveryFailed');
      expect(hostA.textContent).toContain('artifact.recoveryDecisionPending');
      expect(hostA.textContent).toContain('artifact.recoveryReload');
      expect((hostA.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.resolve).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
    controller.taskBoard.completeTask(taskId, 'worker');
    controller.taskBoard.requestReview(taskId, { from: 'worker', reviewer: 'lead' });
    makePendingStart();
    await act(async () => {
      hostB.querySelector('button')!.click();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      await read.mock.results[2].value;
    });
    expect(snapshots[2].transitionId).not.toBe(snapshots[0].transitionId);
    await act(async () => {
      deliverOldResponse();
      await vi.waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
      await transition.mock.results[1].value;
    });
    expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('confirmed');
    expect(await kanbanRecoveryDecisionStorage.read(snapshots[2])).toBeNull();
    expect(controller.kanban.inspectPendingTransition(taskId).transitionId).toBe(
      snapshots[2].transitionId
    );
    expect(confirmButton(hostB)).toBeDefined();
    expect(reload).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });

  it('times out a hung inspection and ignores its late result after an A-B-A context switch', async () => {
    const stale = controller.kanban.inspectPendingTransition(taskId);
    let release!: (value: PendingKanbanTransitionSnapshot) => void;
    mocks.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    await renderPanels();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => hostA.querySelector('button')!.click());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(hostA.textContent).toContain('artifact.recoveryFailed');
      expect(hostA.textContent).toContain('artifact.recoveryReload');
      expect((hostA.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    mocks.state.activeContextId = 'other';
    invalidateContextScopedRequestEpoch();
    mocks.state.activeContextId = 'local';
    invalidateContextScopedRequestEpoch();
    await act(async () => {
      release(stale);
      await mocks.inspect.mock.results[0].value;
    });
    expect(confirmButton(hostA)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'times out a hung decision read %s its actual IndexedDB read and ignores the late result',
    async (stage) => {
      const actualRead = createKanbanRecoveryDecisionStorage().read;
      let release!: () => void;
      let notify!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      read.mockImplementationOnce(async (snapshot) => {
        const prior = stage === 'after' ? await actualRead(snapshot) : null;
        notify();
        await blocked;
        return stage === 'after' ? prior : actualRead(snapshot);
      });
      await renderPanels();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          hostA.querySelector('button')!.click();
          await entered;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(hostA.textContent).toContain('artifact.recoveryFailed');
        expect(hostA.textContent).toContain('artifact.recoveryDecisionUnavailable');
        expect(hostA.textContent).toContain('artifact.recoveryReload');
        expect((hostA.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
      await act(async () => {
        release();
        await read.mock.results[0].value;
      });
      expect(confirmButton(hostA)).toBeUndefined();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'times out a claim %s its actual IndexedDB write without releasing it or asking later',
    async (stage) => {
      const actualClaim = createKanbanRecoveryDecisionStorage().claim;
      let release!: () => void;
      let notify!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      claim.mockImplementationOnce(async (teamName, snapshot) => {
        const prior = stage === 'after' ? await actualClaim(teamName, snapshot) : null;
        notify();
        await blocked;
        return prior ?? actualClaim(teamName, snapshot);
      });
      await renderPanels();
      await inspectBoth();
      const secondButton = confirmButton(hostB)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          confirmButton(hostA)!.click();
          await entered;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(hostA.textContent).toContain('artifact.recoveryFailed');
        expect(hostA.textContent).toContain('artifact.recoveryDecisionUnavailable');
        expect(hostA.textContent).toContain('artifact.recoveryReload');
        expect((hostA.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.resolve).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await act(async () => {
        release();
        await claim.mock.results[0].value;
      });
      expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('prompting');
      await act(async () => {
        secondButton.click();
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
        await claim.mock.results[1].value;
      });
      expect(hostB.textContent).toContain('artifact.recoveryDecisionPending');
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'times out a decision persistence %s its actual IndexedDB write without dispatching later',
    async (stage) => {
      const actualTransition = createKanbanRecoveryDecisionStorage().transition;
      let release!: () => void;
      let notify!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      transition.mockImplementationOnce(async (...args) => {
        if (stage === 'after') await actualTransition(...args);
        notify();
        await blocked;
        if (stage === 'before') await actualTransition(...args);
      });
      await renderPanels();
      await inspectBoth();
      const secondButton = confirmButton(hostB)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          confirmButton(hostA)!.click();
          await entered;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(hostA.textContent).toContain('artifact.recoveryFailed');
        expect(hostA.textContent).toContain('artifact.recoveryDecisionPending');
        expect(hostA.textContent).toContain('artifact.recoveryReload');
        expect(mocks.confirm).toHaveBeenCalledOnce();
        expect(mocks.resolve).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await act(async () => {
        release();
        await transition.mock.results[0].value;
      });
      expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('sending');
      await act(async () => {
        secondButton.click();
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
        await claim.mock.results[1].value;
      });
      expect(hostB.textContent).toContain('artifact.recoveryDecisionPending');
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'times out a declined-decision write %s commit without asking again',
    async (stage) => {
      const actualTransition = createKanbanRecoveryDecisionStorage().transition;
      let release!: () => void;
      let notify!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      transition.mockImplementationOnce(async (...args) => {
        if (stage === 'after') await actualTransition(...args);
        notify();
        await blocked;
        if (stage === 'before') await actualTransition(...args);
      });
      mocks.confirm.mockResolvedValue(false);
      await renderPanels();
      await inspectBoth();
      const secondButton = confirmButton(hostB)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          confirmButton(hostA)!.click();
          await entered;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(hostA.textContent).toContain('artifact.recoveryFailed');
        expect(hostA.textContent).toContain('artifact.recoveryDecisionPending');
        expect(hostA.textContent).toContain('artifact.recoveryReload');
        expect(mocks.confirm).toHaveBeenCalledOnce();
        expect(mocks.resolve).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
      await act(async () => {
        release();
        await transition.mock.results[0].value;
      });
      expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('declined');
      await act(async () => {
        secondButton.click();
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
        await claim.mock.results[1].value;
      });
      expect(hostB.textContent).toContain('artifact.recoveryDecisionDeclined');
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['before', 'after'] as const)(
    'times out a confirmed receipt %s commit without inferring success or resending',
    async (stage) => {
      const actualTransition = createKanbanRecoveryDecisionStorage().transition;
      let release!: () => void;
      let notify!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        notify = resolve;
      });
      transition.mockImplementation(async (...args) => {
        if (args[4] !== 'confirmed') return actualTransition(...args);
        if (stage === 'after') await actualTransition(...args);
        notify();
        await blocked;
        if (stage === 'before') await actualTransition(...args);
      });
      const reload = vi.fn();
      await act(async () => {
        rootA.render(
          <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={reload} />
        );
        rootB.render(
          <TeamReviewRecovery teamName="fixture" error={error()} onRecovered={() => {}} />
        );
      });
      await inspectBoth();
      const secondButton = confirmButton(hostB)!;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await act(async () => {
          confirmButton(hostA)!.click();
          await entered;
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(31_000);
        });
        expect(hostA.textContent).toContain('artifact.recoveryFailed');
        expect(hostA.textContent).toContain('artifact.recoveryDecisionPending');
        expect(hostA.textContent).toContain('artifact.recoveryReload');
        expect(reload).not.toHaveBeenCalled();
        expect(mocks.confirm).toHaveBeenCalledOnce();
        expect(mocks.resolve).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
      await act(async () => {
        release();
        await transition.mock.results[1].value;
      });
      expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('confirmed');
      expect(reload).not.toHaveBeenCalled();
      await act(async () => {
        secondButton.click();
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
        await claim.mock.results[1].value;
      });
      expect(hostB.textContent).toContain('artifact.recoveryDecisionConfirmed');
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.resolve).toHaveBeenCalledOnce();
    }
  );

  it('times out an unsent-decision write after A-B-A and offers manual reload', async () => {
    let answer!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      })
    );
    const actualTransition = createKanbanRecoveryDecisionStorage().transition;
    let release!: () => void;
    let notify!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    transition.mockImplementationOnce(async (...args) => {
      notify();
      await blocked;
      await actualTransition(...args);
    });
    await renderPanels();
    await inspectBoth();
    await act(async () => {
      confirmButton(hostA)!.click();
      await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    });
    mocks.state.activeContextId = 'other';
    invalidateContextScopedRequestEpoch();
    mocks.state.activeContextId = 'local';
    invalidateContextScopedRequestEpoch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        answer(true);
        await entered;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(hostA.textContent).toContain('artifact.recoveryFailed');
      expect(hostA.textContent).toContain('artifact.recoveryReload');
      expect(confirmButton(hostA)).toBeUndefined();
      expect(mocks.resolve).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    await act(async () => {
      release();
      await transition.mock.results[0].value;
    });
    expect((await kanbanRecoveryDecisionStorage.read(snapshots[0]))?.phase).toBe('not_sent');
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
