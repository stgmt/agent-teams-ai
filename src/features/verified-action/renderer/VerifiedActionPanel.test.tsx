import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { VerifiedActionPanel } from './VerifiedActionPanel';

import type { VerifiedAction } from '../contracts';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  decide: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@renderer/api', () => ({ api: { verifiedAction: mocks } }));

const action: VerifiedAction = {
  id: 'b'.repeat(64),
  scope: 'scope',
  teamName: 'team',
  taskId: 'task',
  proof: { attachmentId: 'report', sha256: 'a'.repeat(64), size: 23 },
  status: 'awaiting_approval',
  attempts: 0,
  createdAt: 'now',
  updatedAt: 'now',
};

const expected = {
  appInstanceId: 'app',
  dataRootFingerprint: 'a'.repeat(64),
  connectionGeneration: 1,
};
const expectedRootFingerprint = 'c'.repeat(64);
const guard = {
  taskWriteGuard: {
    status: 'ready' as const,
    reason: null,
    activeId: null,
    markerId: null,
    operation: null,
    unknown: false,
    checked: false,
    expectedContext: expected,
    expectedRootFingerprint,
  },
  beginGuardedTaskWrite: vi.fn(async () => ({
    token: 'guard-token',
    expectedContext: expected,
    expectedRootFingerprint,
  })),
  settleGuardedTaskWrite: vi.fn(async () => true),
  checkGuardedTaskWriteOutcome: vi.fn(async () => undefined),
  confirmGuardedTaskWriteOutcome: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe('VerifiedActionPanel', () => {
  it('does not repeat a write when its response is lost and offers the saved question after a status read', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list
      .mockResolvedValueOnce([action])
      .mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    mocks.approve.mockRejectedValueOnce(new Error('lost response'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      button(host, 'verifiedAction.approve').click();
    });
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(button(host, 'verifiedAction.approve').disabled).toBe(true);
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      button(host, 'verifiedAction.refresh').click();
    });
    expect(host.textContent).toContain('verifiedAction.question');
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('only sends a retry decision after the user selects it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    mocks.decide.mockResolvedValueOnce({ ...action, status: 'manual', attempts: 2 });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      button(host, 'verifiedAction.retry').click();
    });
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide).toHaveBeenCalledWith(
      'local',
      expected,
      expectedRootFingerprint,
      action.id,
      'retry_once'
    );
    expect(host.textContent).toContain('verifiedAction.manual');
    expect(host.textContent).not.toContain('verifiedAction.question');
    await act(async () => {
      root.unmount();
    });
  });

  it('discards a late status response from a previously selected task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveOld!: (value: VerifiedAction[]) => void;
    mocks.list
      .mockReturnValueOnce(
        new Promise<VerifiedAction[]>((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce([
        { ...action, taskId: 'next', proof: { ...action.proof, attachmentId: 'new-report' } },
      ]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="next"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      resolveOld([{ ...action, proof: { ...action.proof, attachmentId: 'old-report' } }]);
    });
    expect(host.textContent).toContain('new-report');
    expect(host.textContent).not.toContain('old-report');
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps a saved question reachable after the artifact requirement is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled={false}
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(host.textContent).toContain('verifiedAction.question');
    expect(host.textContent).not.toContain('verifiedAction.prepare');
    await act(async () => {
      root.unmount();
    });
  });

  it('hides the local queue and never reads it from a remote context', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="ssh:host"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(host.textContent).toBe('');
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('does not start a manifest while an artifact write holds the shared guard', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([action]);
    const occupied = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        activeId: 'artifact-write',
        operation: 'artifact' as const,
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={occupied}
        />
      );
    });
    expect(button(host, 'verifiedAction.approve').disabled).toBe(true);
    expect(host.textContent).toContain('verifiedAction.guardBlocked');
    expect(guard.beginGuardedTaskWrite).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('checks a restored manifest marker before an explicit retry and never retries on its own', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'old-token',
        operation: 'manifest' as const,
        unknown: true,
      },
    };
    const checked = { ...pending, taskWriteGuard: { ...pending.taskWriteGuard, checked: true } };
    mocks.list.mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    mocks.decide.mockResolvedValueOnce({
      ...action,
      status: 'completed',
      completion: 'queued',
      attempts: 2,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (value: typeof pending) =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={value}
        />
      );
    await act(async () => {
      render(pending);
    });
    expect(button(host, 'verifiedAction.retry').disabled).toBe(true);
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      button(host, 'verifiedAction.guardCheck').click();
    });
    expect(guard.checkGuardedTaskWriteOutcome).toHaveBeenCalledWith('manifest');
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      render(checked);
    });
    await act(async () => {
      button(host, 'verifiedAction.retry').click();
    });
    expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledWith('old-token', 'manifest');
    expect(guard.beginGuardedTaskWrite).toHaveBeenCalledWith('manifest');
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide).toHaveBeenCalledWith(
      'local',
      expected,
      expectedRootFingerprint,
      action.id,
      'retry_once'
    );
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps a timed-out write unknown when its response arrives late', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    mocks.list.mockResolvedValueOnce([action]);
    let resolveWrite!: (value: VerifiedAction) => void;
    mocks.approve.mockReturnValueOnce(
      new Promise<VerifiedAction>((resolve) => {
        resolveWrite = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      button(host, 'verifiedAction.approve').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(guard.settleGuardedTaskWrite).toHaveBeenCalledWith('guard-token', 'manifest', 'unknown');
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      resolveWrite({ ...action, status: 'completed', completion: 'queued', attempts: 1 });
    });
    expect(guard.settleGuardedTaskWrite).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
  });
});
