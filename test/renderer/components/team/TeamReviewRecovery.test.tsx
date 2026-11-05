import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import en from '@features/localization/renderer/locales/en/team.json';
import { TeamReviewRecovery } from '@renderer/components/team/TeamReviewRecovery';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  resolve: vi.fn(),
  confirm: vi.fn(),
  state: { activeContextId: 'local', isContextSwitching: false },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
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
vi.mock('@renderer/components/team/kanbanRecoveryDecision', () => ({
  kanbanRecoveryDecisionStorage: {
    read: vi.fn(async () => null),
    claim: vi.fn(async () => ({
      claimed: true,
      record: { owner: '12345678-1234-4234-9234-123456789abc' },
    })),
    transition: vi.fn(async () => undefined),
    matches: vi.fn(() => true),
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, args?: Record<string, string>) => {
      const base = key.startsWith('artifact.')
        ? en.artifact[key.slice('artifact.'.length) as keyof typeof en.artifact]
        : key;
      return Object.entries(args ?? {}).reduce(
        (value, [name, item]) => value.replace(`{{${name}}}`, item),
        base
      );
    },
  }),
}));

describe('TeamReviewRecovery', () => {
  let host: HTMLDivElement;
  let root: Root;
  const error =
    'Review transition for task task-1 has an unknown outcome; inspect the task and board before further changes.';
  const statusError =
    'KANBAN_TRANSITION_UNCERTAIN: Task status transition for task task-1 has an unknown outcome; inspect before further changes.';
  const snapshot = {
    taskId: 'task-1',
    contextHash: 'c'.repeat(64),
    transitionId: '12345678-1234-4234-9234-123456789abc',
    column: 'review',
    currentColumn: null,
    mode: 'publish',
    snapshotHash: 'a'.repeat(64),
  };
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    mocks.state.activeContextId = 'local';
    mocks.state.isContextSwitching = false;
    mocks.inspect.mockResolvedValue(snapshot);
    mocks.resolve.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('checks first and asks once before applying the saved projection', async () => {
    const recovered = vi.fn();
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={error} onRecovered={recovered} />)
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('task-1');
    expect(host.textContent).toContain('no review column');
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === en.artifact.recoveryConfirm)!
        .click()
    );
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledWith('team-a', 'task-1', snapshot);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('does not offer confirmation when the board changed', async () => {
    mocks.inspect.mockResolvedValue({ ...snapshot, mode: 'conflict' });
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={error} onRecovered={vi.fn()} />)
    );
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain(en.artifact.recoveryConflict);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === en.artifact.recoveryConfirm
      )
    ).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('explains an invalid artifact and does not offer confirmation', async () => {
    mocks.inspect.mockResolvedValue({ ...snapshot, mode: 'conflict', reason: 'artifact_invalid' });
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={error} onRecovered={vi.fn()} />)
    );
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain(en.artifact.recoveryArtifactConflict);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === en.artifact.recoveryConfirm
      )
    ).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not retry an unknown confirmation result', async () => {
    mocks.resolve.mockRejectedValue(new Error('timeout'));
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={error} onRecovered={vi.fn()} />)
    );
    await act(async () => host.querySelector('button')!.click());
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === en.artifact.recoveryConfirm)!
        .click()
    );
    expect(host.textContent).toContain(en.artifact.recoveryFailed);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === en.artifact.recoveryConfirm
      )
    ).toBe(false);
  });

  it('does not send a delayed confirmation after an A-B-A context switch', async () => {
    let accept!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        accept = resolve;
      })
    );
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={error} onRecovered={vi.fn()} />)
    );
    await act(async () => host.querySelector('button')!.click());
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === en.artifact.recoveryConfirm)!
        .click()
    );
    mocks.state.activeContextId = 'other';
    invalidateContextScopedRequestEpoch();
    mocks.state.activeContextId = 'local';
    invalidateContextScopedRequestEpoch();
    await act(async () => accept(true));
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'prepared', 'status', 'in_progress', 'recoveryStatusCancel'],
    ['publish', 'applied', 'request_changes', 'pending', 'recoveryStatusPublish'],
    ['clear', 'applied', 'clear', 'completed', 'recoveryStatusClear'],
    ['cancel', 'prepared', 'clear', 'completed', 'recoveryClearCancel'],
  ] as const)(
    'explains %s status recovery and requires one explicit decision',
    async (mode, phase, operation, targetStatus, detailKey) => {
      const saved = {
        ...snapshot,
        column: 'none',
        currentColumn: 'review',
        mode,
        phase,
        operation,
        targetStatus,
      };
      mocks.inspect.mockResolvedValue(saved);
      await act(async () =>
        root.render(
          <TeamReviewRecovery teamName="team-a" error={statusError} onRecovered={vi.fn()} />
        )
      );
      await act(async () => host.querySelector('button')!.click());
      expect(host.textContent).toContain(en.artifact[detailKey]);
      expect(host.textContent).toContain('review');
      if (operation === 'request_changes') {
        expect(host.textContent).toContain(en.artifact.recoveryRequestChangesNote);
      }
      await act(async () =>
        Array.from(host.querySelectorAll('button'))
          .find((button) => button.textContent === en.artifact.recoveryConfirm)!
          .click()
      );
      expect(mocks.confirm).toHaveBeenCalledOnce();
      expect(mocks.confirm.mock.calls[0][0].message).toBe(en.artifact[detailKey]);
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('team-a', 'task-1', saved);
    }
  );

  it('does not resolve a malformed status recovery snapshot', async () => {
    mocks.inspect.mockResolvedValue({
      ...snapshot,
      column: 'none',
      mode: 'cancel',
      phase: 'applied',
      operation: 'status',
      targetStatus: 'pending',
    });
    await act(async () =>
      root.render(
        <TeamReviewRecovery teamName="team-a" error={statusError} onRecovered={vi.fn()} />
      )
    );
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain(en.artifact.recoveryConflict);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent === en.artifact.recoveryConfirm
      )
    ).toBe(false);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('offers a read-only reload when an early status error left no marker to inspect', async () => {
    mocks.inspect.mockRejectedValue(new Error('No pending Kanban transition'));
    const reload = vi.fn();
    await act(async () =>
      root.render(<TeamReviewRecovery teamName="team-a" error={statusError} onRecovered={reload} />)
    );
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain(en.artifact.recoveryInspectFailed);
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === en.artifact.recoveryReload)!
        .click()
    );
    expect(reload).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it('does not ask twice when confirmation is clicked twice before rendering', async () => {
    let answer!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      })
    );
    await act(async () =>
      root.render(
        <TeamReviewRecovery teamName="team-a" error={statusError} onRecovered={vi.fn()} />
      )
    );
    mocks.inspect.mockResolvedValue({
      ...snapshot,
      column: 'none',
      mode: 'cancel',
      phase: 'prepared',
      operation: 'status',
      targetStatus: 'pending',
    });
    await act(async () => host.querySelector('button')!.click());
    const button = Array.from(host.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === en.artifact.recoveryConfirm
    )!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    await act(async () => answer(true));
    expect(mocks.resolve).toHaveBeenCalledOnce();
  });
});
