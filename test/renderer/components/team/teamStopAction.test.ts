import enTeam from '@features/localization/renderer/locales/en/team.json';
import ruTeam from '@features/localization/renderer/locales/ru/team.json';
import { runTeamStopAction } from '@renderer/components/team/teamStopAction';
import { TaskActivityStopError } from '@shared/utils/teamStopErrors';
import { describe, expect, it, vi } from 'vitest';

import type { TeamStopActionPorts } from '@renderer/components/team/teamStopAction';

type TestPorts = TeamStopActionPorts & {
  setBusy: ReturnType<typeof vi.fn>;
};

function createPorts(overrides: Partial<TeamStopActionPorts> = {}): TestPorts {
  return {
    teamName: 'demo-team',
    stop: vi.fn().mockResolvedValue(undefined),
    processAlive: vi.fn().mockResolvedValue(false),
    refresh: vi.fn().mockResolvedValue(undefined),
    setBusy: vi.fn(),
    reportFailure: vi.fn(),
    logError: vi.fn(),
    logRefreshError: vi.fn(),
    ...overrides,
  } as TestPorts;
}

describe('runTeamStopAction', () => {
  it('stops exactly once, refreshes, and releases busy state', async () => {
    const ports = createPorts();
    await expect(runTeamStopAction(ports)).resolves.toBe('stopped');
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.stop).toHaveBeenCalledWith('demo-team');
    expect(ports.processAlive).not.toHaveBeenCalled();
    expect(ports.refresh).toHaveBeenCalledTimes(1);
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it('does not infer completed task clocks from a transport error and dead process', async () => {
    const ports = createPorts({ stop: vi.fn().mockRejectedValue(new Error('lost response')) });
    await expect(runTeamStopAction(ports)).resolves.toBe('status_unknown');
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.processAlive).toHaveBeenCalledTimes(1);
    expect(ports.reportFailure).toHaveBeenCalledOnce();
    expect(ports.reportFailure).toHaveBeenCalledWith('status_unknown', 'lost response');
    expect(ports.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, false, 'stopped_activity_review_pending'],
    [false, false, 'stopped_activity_unconfirmed'],
    [true, true, 'activity_and_cleanup_unconfirmed'],
    [false, true, 'activity_and_cleanup_unconfirmed'],
  ] as const)(
    'shows the task-clock failure after string-only transport (pending=%s, cleanup=%s)',
    async (pending, cleanupUnconfirmed, expected) => {
      const original = new TaskActivityStopError(pending, cleanupUnconfirmed);
      const ports = createPorts({ stop: vi.fn().mockRejectedValue(new Error(original.message)) });
      await expect(runTeamStopAction(ports)).resolves.toBe(expected);
      expect(ports.reportFailure).toHaveBeenCalledExactlyOnceWith(expected, original.message);
      expect(ports.stop).toHaveBeenCalledTimes(1);
      expect(ports.processAlive).not.toHaveBeenCalled();
      expect(ports.refresh).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['stopActivityPending', 'stopActivityUnknown', 'stopActivityCleanupUnknown'] as const)(
    'the %s messages identify the previous run and advise checking for a new one',
    (key) => {
      expect(enTeam.detail[key].message).toContain('previous run');
      expect(enTeam.detail[key].message).toContain('new run');
      expect(enTeam.detail[key].message).toContain('Do not repeat Stop');
      expect(ruTeam.detail[key].message).toContain('прежнего запуска');
      expect(ruTeam.detail[key].message).toContain('новый запуск');
      expect(ruTeam.detail[key].message).toContain('Не повторяйте остановку');
    }
  );

  it('reports a timed-out stop as unknown without probing or retrying it', async () => {
    const ports = createPorts({
      stop: vi.fn().mockRejectedValue(new Error('team_stop_unconfirmed:timed_out')),
    });
    await expect(runTeamStopAction(ports)).resolves.toBe('status_unknown');
    expect(ports.reportFailure).toHaveBeenCalledExactlyOnceWith(
      'status_unknown',
      'team_stop_unconfirmed:timed_out'
    );
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.processAlive).not.toHaveBeenCalled();
  });

  it('reports still-running without retrying stop', async () => {
    const ports = createPorts({
      stop: vi.fn().mockRejectedValue(new Error('runtime rejected stop')),
      processAlive: vi.fn().mockResolvedValue(true),
    });
    await expect(runTeamStopAction(ports)).resolves.toBe('still_running');
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.reportFailure).toHaveBeenCalledWith('still_running', 'runtime rejected stop');
    expect(ports.refresh).toHaveBeenCalledTimes(1);
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it('reports an unknown status when the liveness probe fails', async () => {
    const ports = createPorts({
      stop: vi.fn().mockRejectedValue(new Error('lost response')),
      processAlive: vi.fn().mockRejectedValue(new Error('probe unavailable')),
    });
    await expect(runTeamStopAction(ports)).resolves.toBe('status_unknown');
    expect(ports.stop).toHaveBeenCalledTimes(1);
    expect(ports.processAlive).toHaveBeenCalledTimes(1);
    expect(ports.reportFailure).toHaveBeenCalledWith('status_unknown', 'probe unavailable');
    expect(ports.refresh).toHaveBeenCalledTimes(1);
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it('does not change a successful outcome when refresh fails', async () => {
    const refreshError = new Error('refresh failed');
    const ports = createPorts({ refresh: vi.fn().mockRejectedValue(refreshError) });
    await expect(runTeamStopAction(ports)).resolves.toBe('stopped');
    expect(ports.logError).not.toHaveBeenCalled();
    expect(ports.logRefreshError).toHaveBeenCalledWith(refreshError);
    expect(ports.reportFailure).not.toHaveBeenCalled();
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ['stopped', {}],
    ['status_unknown', { stop: vi.fn().mockRejectedValue(new Error('lost')) }],
    [
      'still_running',
      {
        stop: vi.fn().mockRejectedValue(new Error('failed')),
        processAlive: vi.fn().mockResolvedValue(true),
      },
    ],
    [
      'status_unknown',
      {
        stop: vi.fn().mockRejectedValue(new Error('failed')),
        processAlive: vi.fn().mockRejectedValue(new Error('unknown')),
      },
    ],
  ] as const)('releases busy state for %s', async (_outcome, overrides) => {
    const ports = createPorts(overrides);
    await runTeamStopAction(ports);
    expect(ports.setBusy.mock.calls).toEqual([[true], [false]]);
  });
});
