// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeTeamHttpApis } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamHttpApis';

import type { NativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const progress = {
  runId: 'TEST-run',
  teamName: 'TEST-team',
  status: 'running',
} as unknown as TeamProvisioningProgress;

function setup() {
  const findByRunId = vi.fn(async () => progress);
  const memberSpawnStatuses = vi.fn(async () => ({
    statuses: {},
    runId: 'TEST-run',
    expectedMembers: [],
    source: 'live' as const,
  }));
  const runtimeSnapshot = vi.fn(async () => ({
    teamName: 'TEST-team',
    updatedAt: '2026-10-31T00:00:00.000Z',
    runId: 'TEST-run',
    members: {},
  }));
  const lifecycle = {
    owner,
    queries: { snapshot: vi.fn(async () => null) },
  };
  const runtime = {
    createTeam: vi.fn(),
    launchTeam: vi.fn(),
    cancelProvisioning: vi.fn(),
    hasProvisioningRun: vi.fn(),
    getRuntimeState: vi.fn(),
    stopTeam: vi.fn(async () => undefined),
    isTeamAlive: vi.fn(),
    getAliveTeams: vi.fn(() => ['TEST-team']),
    getCurrentRunId: vi.fn(),
    findByRunId,
  };
  const runtimeControl = {
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(),
    deliverOpenCodeRuntimeMessage: vi.fn(),
    recordOpenCodeRuntimeTaskEvent: vi.fn(),
    recordOpenCodeRuntimeHeartbeat: vi.fn(),
    answerOpenCodeRuntimePermission: vi.fn(),
  };
  const apis = createNativeTeamHttpApis({
    runtime: {
      lifecycle,
      runtime,
      logs: { read: vi.fn() },
      recoverStartup: vi.fn(),
    } as unknown as NativeDesktopTeamRuntime,
    taskActivity: { repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(async () => undefined) },
    runtimeControl,
    now: () => '2026-10-31T00:00:00.000Z',
  });
  return { apis, findByRunId, runtimeControl, memberSpawnStatuses, runtimeSnapshot };
}

describe('native team HTTP API composition', () => {
  it('assembles the HTTP handler surface', () => {
    const { apis } = setup();
    expect(Object.keys(apis).sort()).toEqual([
      'memberDiagnostics',
      'provisioningStart',
      'provisioningStatus',
      'runtime',
      'runtimeControl',
      'taskActivity',
    ]);
  });

  it('routes status and read-only diagnostics through the native runtime', async () => {
    const { apis, findByRunId, runtimeControl } = setup();
    await expect(apis.provisioningStatus.getProvisioningStatus('TEST-run')).resolves.toBe(progress);
    expect(findByRunId).toHaveBeenCalledWith('TEST-run');
    await expect(
      apis.memberDiagnostics.getMemberSpawnStatusesReadOnly('TEST-team')
    ).resolves.toMatchObject({
      source: 'live',
    });
    await expect(
      apis.memberDiagnostics.getTeamAgentRuntimeSnapshotReadOnly('TEST-team')
    ).resolves.toMatchObject({ teamName: 'TEST-team' });
    expect(apis.runtimeControl).toBe(runtimeControl);
  });
});
