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
  const snapshot = {
    taskId: 'task-1',
    contextHash: 'c'.repeat(64),
    transitionId: 't1',
    column: 'review',
    currentColumn: null,
    mode: 'publish',
    snapshotHash: 'hash',
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
});
