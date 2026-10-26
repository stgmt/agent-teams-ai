import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeSnapshot';

import type { RuntimeTelemetryProcessTableRow } from '../../TeamRuntimeTelemetry';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { PersistedRuntimeMemberLike } from '../TeamProvisioningRuntimeSnapshot';
import type { TeamProvisioningRuntimeSnapshotRun } from '../TeamProvisioningRuntimeSnapshotTypes';
import type { MemberSpawnStatusEntry, TeamConfig } from '@shared/types';

vi.mock('@features/tmux-installer/main', () => ({
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
}));

vi.mock('../../TeamBootstrapStateReader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../TeamBootstrapStateReader')>();
  return {
    ...actual,
    readBootstrapLaunchSnapshot: vi.fn(async () => null),
  };
});

/**
 * A Claude teammate on Windows runs as a native `claude-multimodel.exe` process
 * (backend `process`), and a Claude team has no runtime adapter run, so its
 * evidence owner is 'none'. Its bootstrap heartbeat is only refreshed by
 * activity: an idle teammate's heartbeat ages past the stale window two minutes
 * after it confirmed. From then on the process table is the only liveness
 * evidence left, and on win32 the shared table is WSL's `ps`, which cannot list
 * a Windows process at all. Without the Windows host table every idle teammate
 * read as "registered" and the launch panel kept saying the team was still
 * joining while all of its teammates were running.
 */

const TEAM_NAME = 'native-windows-liveness-test';
const RUN_ID = 'run-current';
const CONFIRMED_AT = '2026-01-01T00:00:00.000Z';
const WORKER_PID = 4242;
const WORKER_AGENT_ID = `Worker@${TEAM_NAME}`;
const WORKDIR = '/safe-test-workspace/native-windows-liveness-test';
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function teammateCommand(teamName: string, agentId: string): string {
  return [
    '"C:\\Program Files\\AgentTeamsAI\\resources\\runtime\\claude-multimodel.exe"',
    '--teammate-runtime headless',
    `--agent-id ${agentId}`,
    `--agent-name ${agentId.split('@')[0]}`,
    `--team-name ${teamName}`,
    '--model claude-sonnet-4-6',
  ].join(' ');
}

function hostRow(command: string, pid = WORKER_PID): RuntimeTelemetryProcessTableRow {
  return { pid, ppid: 100, command, runtimeTelemetrySource: 'windows-host' };
}

function confirmedStatus(): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    livenessKind: 'confirmed_bootstrap',
    lastHeartbeatAt: CONFIRMED_AT,
    updatedAt: CONFIRMED_AT,
  };
}

function claudeConfig(): TeamConfig {
  return {
    name: TEAM_NAME,
    members: [
      { name: 'Worker', providerId: 'anthropic', model: 'claude-sonnet-4-6', cwd: WORKDIR },
    ],
  };
}

function claudeRun(): TeamProvisioningRuntimeSnapshotRun {
  const member = {
    name: 'Worker',
    providerId: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    cwd: WORKDIR,
  };
  return {
    runId: RUN_ID,
    child: null,
    processKilled: false,
    cancelRequested: false,
    request: {
      teamName: TEAM_NAME,
      members: [member],
      cwd: WORKDIR,
      providerId: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    effectiveMembers: [member],
    allEffectiveMembers: [member],
    memberSpawnStatuses: new Map([['Worker', confirmedStatus()]]),
  };
}

function persistedWorker(): PersistedRuntimeMemberLike {
  return {
    name: 'Worker',
    agentId: WORKER_AGENT_ID,
    backendType: 'process',
    tmuxPaneId: `process:${WORKER_PID}`,
    providerId: 'anthropic',
    cwd: WORKDIR,
    bootstrapRunId: RUN_ID,
    runtimePid: WORKER_PID,
  };
}

async function resolveIdleWorker(options: {
  hostRows: RuntimeTelemetryProcessTableRow[];
  sharedTableAvailable: boolean;
}): Promise<{ worker: LiveTeamAgentRuntimeMetadata | undefined; hostRowsRead: boolean }> {
  const readWindowsHostProcessRows = vi.fn(async () => ({
    rows: options.hostRows,
    processTableAvailable: true,
  }));
  const metadata = await buildLiveTeamAgentRuntimeMetadata({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, claudeRun()]]),
    runtimeAdapterRunByTeam: new Map(),
    teamMetaStore: { getMeta: vi.fn(async () => ({ providerId: 'anthropic' as const })) },
    membersMetaStore: { getMembers: vi.fn(async () => []) },
    launchStateStore: { read: vi.fn(async () => null) },
    readConfigSnapshot: vi.fn(async () => claudeConfig()),
    readPersistedRuntimeMembers: vi.fn(() => [persistedWorker()]),
    // WSL's `ps`: either unreachable, or answering from another pid namespace.
    readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: [],
      processTableAvailable: options.sharedTableAvailable,
    })),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: readWindowsHostProcessRows,
    isRuntimePidAlive: () => true,
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
    getTrackedRunId: vi.fn(() => RUN_ID),
    getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
    liveRuntimeMetadataCache: { rememberLiveTeamAgentRuntimeMetadata: vi.fn() },
    logDebug: vi.fn(),
  });
  return {
    worker: metadata.get('Worker'),
    hostRowsRead: readWindowsHostProcessRows.mock.calls.length > 0,
  };
}

describe('liveness of an idle native Claude teammate on Windows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ten minutes after the bootstrap heartbeat: well past the 2-minute stale window.
    vi.setSystemTime(new Date(Date.parse(CONFIRMED_AT) + 10 * 60_000));
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(ORIGINAL_PLATFORM);
    vi.useRealTimers();
  });

  it.each([
    ['unreachable', false],
    ['answering without Windows processes', true],
  ])(
    'is alive when the Windows host table lists its process (WSL table %s)',
    async (_label, available) => {
      const { worker, hostRowsRead } = await resolveIdleWorker({
        hostRows: [hostRow(teammateCommand(TEAM_NAME, WORKER_AGENT_ID))],
        sharedTableAvailable: available,
      });

      expect(hostRowsRead).toBe(true);
      expect(worker).toMatchObject({ alive: true, livenessKind: 'runtime_process' });
    }
  );

  // Negative controls: the host table is evidence only for the process whose
  // flags name this team and this teammate; a bare pid match proves nothing.
  it('stays not alive when the recorded pid belongs to another teammate', async () => {
    const { worker } = await resolveIdleWorker({
      hostRows: [hostRow(teammateCommand(TEAM_NAME, `Other@${TEAM_NAME}`))],
      sharedTableAvailable: false,
    });

    expect(worker?.alive).toBe(false);
    expect(worker?.livenessKind).not.toBe('runtime_process');
  });

  it('stays not alive when the matching process belongs to another team', async () => {
    const { worker } = await resolveIdleWorker({
      hostRows: [hostRow(teammateCommand('other-team', WORKER_AGENT_ID))],
      sharedTableAvailable: false,
    });

    expect(worker?.alive).toBe(false);
    expect(worker?.livenessKind).not.toBe('runtime_process');
  });

  // The table that can list its process answered without it: that disproves
  // the recorded pid instead of leaving the registration unverified.
  it('is not alive when the Windows host table does not list it', async () => {
    const { worker } = await resolveIdleWorker({ hostRows: [], sharedTableAvailable: false });

    expect(worker).toMatchObject({ alive: false, livenessKind: 'stale_metadata' });
  });
});
