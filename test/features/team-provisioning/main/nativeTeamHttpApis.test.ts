// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeTeamHttpApis } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamHttpApis';

import type {
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';
import type { NativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const run: TeamRunIdentity = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };

const progress = {
  runId: 'TEST-run',
  teamName: 'TEST-team',
  status: 'running',
} as unknown as TeamProvisioningProgress;

function member(memberName: string, role: 'lead' | 'member') {
  return {
    memberName,
    role,
    membership: 'configured' as const,
    desired: 'running' as const,
    phase: 'ready' as const,
    resources: 'held' as const,
    generation: 1,
    operationId: `TEST-op-${memberName}`,
    process: { pid: role === 'lead' ? 100 : 101, birthId: `TEST-birth-${memberName}` },
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
  };
}

const snapshot = {
  identity: run,
  desired: 'running',
  resources: 'held',
  state: 'ready',
  error: null,
  version: 1,
  startedAt: '2026-10-31T00:00:00.000Z',
  members: {
    'team-lead': member('team-lead', 'lead'),
    builder: member('builder', 'member'),
  },
} as unknown as TeamLifecycleSnapshot;

function setup() {
  const findByRunId = vi.fn(async () => progress);
  const readSnapshot = vi.fn(async () => snapshot);
  const lifecycle = {
    owner,
    queries: { snapshot: readSnapshot },
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
  return { apis, findByRunId, readSnapshot, runtimeControl };
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
    expect(apis.runtimeControl).toBe(runtimeControl);
  });

  it('projects both diagnostics halves from the same run snapshot', async () => {
    const { apis, readSnapshot } = setup();
    const statuses = await apis.memberDiagnostics.getMemberSpawnStatusesReadOnly('TEST-team');
    expect(statuses.runId).toBe('TEST-run');
    expect(statuses.statuses.builder).toMatchObject({ status: 'online', runtimeAlive: true });

    const runtime = await apis.memberDiagnostics.getTeamAgentRuntimeSnapshotReadOnly('TEST-team', {
      memberSpawnStatuses: statuses,
    });
    expect(runtime.runId).toBe('TEST-run');
    expect(runtime.members.builder).toMatchObject({ alive: true });
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
});
