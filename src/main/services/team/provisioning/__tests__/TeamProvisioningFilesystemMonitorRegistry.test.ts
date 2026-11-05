import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from '../TeamProvisioningFilesystemMonitor';
import type { TeamProvisioningFilesystemMonitorRun } from '../TeamProvisioningFilesystemMonitor';
import type { TeamCreateRequest } from '@shared/types';

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/sandbox/teams',
  getAutoDetectedClaudeBasePath: () => '/sandbox',
}));

describe('registry-only provisioning filesystem monitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not treat canonical task files as readiness and completes after the fallback', async () => {
    vi.useFakeTimers();
    const access = vi.spyOn(fs.promises, 'access').mockResolvedValue(undefined);
    const readdir = vi.spyOn(fs.promises, 'readdir').mockResolvedValue([] as never);
    const complete = vi.fn().mockResolvedValue(undefined);
    const run = {
      teamName: 'sandbox',
      fsMonitorHandle: null,
      effectiveMembers: [],
      deterministicBootstrap: false,
      fsPhase: 'waiting_config',
      waitingTasksSince: null,
      cancelRequested: false,
      processKilled: false,
      progress: { state: 'assembling' },
      onProgress: vi.fn(),
      provisioningComplete: false,
    } as unknown as TeamProvisioningFilesystemMonitorRun;
    const request = { members: [] } as unknown as TeamCreateRequest;
    startProvisioningFilesystemMonitor(run, request, {
      updateProgress: (_run, state) =>
        ({ state }) as TeamProvisioningFilesystemMonitorRun['progress'],
      getRegisteredTeamMemberNames: vi.fn().mockResolvedValue(null),
      handleProvisioningTurnComplete: complete,
    });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(run.fsPhase).toBe('waiting_tasks');
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.fsPhase).toBe('all_files_found');
    expect(complete).toHaveBeenCalledOnce();
    expect(readdir).not.toHaveBeenCalled();
    expect(access.mock.calls.every(([file]) => !String(file).includes('/tasks/'))).toBe(true);
    stopProvisioningFilesystemMonitor(run);
  });
});
