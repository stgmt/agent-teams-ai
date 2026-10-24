import { describe, expect, it, vi } from 'vitest';

import { createTeamDowntimeStore } from '../../state/teamDowntimeStore';
import { type ProvisioningProgressSubscribe, watchTeamDowntime } from '../watchTeamDowntime';

import type { TeamProvisioningProgress } from '@shared/types';

function progress(overrides: Partial<TeamProvisioningProgress>): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'my-team',
    state: 'ready',
    message: 'Ready',
    startedAt: '2026-10-24T05:00:00.000Z',
    updatedAt: '2026-10-24T05:48:27.000Z',
    ...overrides,
  };
}

function setup(): {
  store: ReturnType<typeof createTeamDowntimeStore>;
  stop: () => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  emit: (value: TeamProvisioningProgress) => void;
} {
  let listener: ((event: unknown, value: TeamProvisioningProgress) => void) | null = null;
  const unsubscribe = vi.fn();
  const subscribe: ProvisioningProgressSubscribe = (next) => {
    listener = next;
    return unsubscribe;
  };
  const store = createTeamDowntimeStore();
  const stop = watchTeamDowntime(subscribe, store);
  return {
    store,
    stop,
    unsubscribe,
    emit: (value: TeamProvisioningProgress) => listener?.({}, value),
  };
}

describe('watchTeamDowntime', () => {
  it('NM-S06: a live process_exit opens an episode with code, time and log tail', () => {
    const { store, emit } = setup();

    emit(
      progress({
        state: 'disconnected',
        disconnect: { kind: 'process_exit', exitCode: 1 },
        cliLogsTail: 'last line',
      })
    );

    expect(store.getState().episodes['my-team']).toEqual({
      exit: {
        exitCode: 1,
        occurredAt: '2026-10-24T05:48:27.000Z',
        cliLogsTail: 'last line',
      },
      ownerMessageAt: null,
      dismissed: false,
    });
  });

  it('NM-S04: a stop by the user opens no episode and closes an open one', () => {
    const { store, emit } = setup();

    emit(progress({ state: 'disconnected', disconnect: { kind: 'user_stop' } }));
    expect(store.getState().episodes['my-team']).toBeUndefined();

    store.getState().recordOwnerMessage('my-team', '2026-10-24T06:00:00.000Z');
    emit(progress({ state: 'disconnected', disconnect: { kind: 'user_stop' } }));
    expect(store.getState().episodes['my-team']).toBeUndefined();
  });

  it('ignores a disconnected event without a typed reason (other runtimes)', () => {
    const { store, emit } = setup();

    emit(progress({ state: 'disconnected', message: 'Team process exited unexpectedly (code 1)' }));

    expect(store.getState().episodes['my-team']).toBeUndefined();
  });

  it.each([
    'validating',
    'spawning',
    'configuring',
    'assembling',
    'finalizing',
    'verifying',
    'ready',
    'failed',
    'cancelled',
  ] as const)('NM-S08: a %s event ends the episode of that team only', (state) => {
    const { store, emit } = setup();
    store.getState().recordProcessExit('my-team', {
      exitCode: 1,
      occurredAt: '2026-10-24T05:48:27.000Z',
    });
    store.getState().recordProcessExit('other-team', {
      exitCode: 1,
      occurredAt: '2026-10-24T05:48:27.000Z',
    });

    emit(progress({ state }));

    expect(store.getState().episodes['my-team']).toBeUndefined();
    expect(store.getState().episodes['other-team']).toBeDefined();
  });

  it('reports one exit per run: a repeated event of the same run does not reopen the outage', () => {
    const { store, emit } = setup();
    const exited = progress({
      state: 'disconnected',
      disconnect: { kind: 'process_exit', exitCode: 1 },
    });
    emit(exited);
    store.getState().clear('my-team');

    emit({ ...exited, updatedAt: '2026-10-24T05:48:30.000Z', cliLogsTail: 'refreshed' });

    expect(store.getState().episodes['my-team']).toBeUndefined();

    emit({
      ...exited,
      runId: 'run-2',
      disconnect: { kind: 'process_exit', exitCode: 137 },
    });
    expect(store.getState().episodes['my-team']?.exit).toMatchObject({ exitCode: 137 });
  });

  it('stops listening when disposed', () => {
    const { stop, unsubscribe } = setup();

    stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
