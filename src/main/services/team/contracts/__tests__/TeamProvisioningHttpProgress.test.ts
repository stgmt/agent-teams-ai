import { describe, expect, it, vi } from 'vitest';

import { bindTeamHttpHandlerApis } from '../TeamProvisioningApis';

import type { TeamProvisioningProgress } from '@shared/types';

const disconnected: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'demo-team',
  state: 'disconnected',
  message: 'Team process exited unexpectedly (code 1)',
  startedAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:48:27.000Z',
  disconnect: { kind: 'process_exit', exitCode: 1 },
};

// РИСК: сервис запуска подменён объектом, который сам вызывает переданный обработчик хода
// запуска; проверяется только доставка этого хода окну приложения, а не работа настоящего запуска
// (её покрывает живой тест test/live/teamNotRunning.live.test.ts, NM-S23).
function createSource(publishProvisioningProgress: (progress: TeamProvisioningProgress) => void): {
  source: Parameters<typeof bindTeamHttpHandlerApis>[0];
} {
  const startRun = vi.fn(
    async (_request: unknown, onProgress: (progress: TeamProvisioningProgress) => void) => {
      onProgress(disconnected);
      return { runId: 'run-1' };
    }
  );
  // Only the start path is exercised; every other method of the service resolves to a no-op.
  const declared: Record<string, unknown> = {
    createTeam: startRun,
    launchTeam: startRun,
    publishProvisioningProgress,
    // A second live team keeps the OpenCode start preparation off the real data directory.
    getAliveTeams: () => ['someone-else'],
  };
  const source = new Proxy(declared, {
    get: (target, key: string) => target[key] ?? (() => Promise.resolve(undefined)),
  }) as unknown as Parameters<typeof bindTeamHttpHandlerApis>[0];
  return { source };
}

describe('team HTTP start API progress delivery', () => {
  it('NM-S23: a launch over HTTP hands every progress event to the app window', async () => {
    const publish = vi.fn();
    const onProgress = vi.fn();
    const { source } = createSource(publish);

    await bindTeamHttpHandlerApis(source).provisioningStart.launchTeam(
      { teamName: 'demo-team', cwd: process.cwd(), providerId: 'anthropic' },
      onProgress
    );

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(disconnected);
    expect(onProgress).toHaveBeenCalledWith(disconnected);
  });

  it('NM-S23: a create over HTTP (a saved draft launch) delivers its progress too', async () => {
    const publish = vi.fn();
    const { source } = createSource(publish);

    await bindTeamHttpHandlerApis(source).provisioningStart.createTeam(
      {
        teamName: 'demo-team',
        cwd: process.cwd(),
        providerId: 'anthropic',
        members: [{ name: 'builder', role: 'Engineer', providerId: 'anthropic' }],
      },
      vi.fn()
    );

    expect(publish).toHaveBeenCalledWith(disconnected);
  });
});
