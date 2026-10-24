/**
 * SR-13 спеки bugfix-member-save-restart: статус мёртвого агента.
 *
 * Причина RC4 (evidence.md, RT-05): у участника с подтверждённым запуском
 * TeamRuntimeLivenessResolver.ts отдаёт `confirmed_bootstrap, alive: true` ДО проверки записанного pid,
 * а attachLiveRuntimeMetadataToStatuses не опускает подтверждённого участника при слабых данных.
 * Мёртвый pid поэтому остаётся `online / confirmed_alive / runtimeAlive: true`.
 *
 * Здесь проверяется настоящий код сборки данных о живости и настоящий разбор статусов.
 * РИСК: проверка pid в тесте моделируется портом `isRuntimePidAlive`; настоящий `process.kill(pid, 0)`
 * проверяет отдельный тест на живом процессе в конце файла.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  attachLiveRuntimeMetadataToStatuses,
  buildLiveTeamAgentRuntimeMetadata,
  buildTeamAgentRuntimeSnapshot,
  type PersistedRuntimeMemberLike,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningRuntimeSnapshot';
import { isProcessAlive } from '../../../../src/main/utils/processHealth';

import type { LiveTeamAgentRuntimeMetadata } from '../../../../src/main/services/team/provisioning/TeamProvisioningRuntimeMetadataPolicy';
import type { RuntimeTelemetryProcessTableRow } from '../../../../src/main/services/team/TeamRuntimeTelemetry';
import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamConfig,
} from '../../../../src/shared/types';

vi.mock('@features/tmux-installer/main', () => ({
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
}));

vi.mock('../../../../src/main/services/team/TeamBootstrapStateReader', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/main/services/team/TeamBootstrapStateReader')
    >();
  return { ...actual, readBootstrapLaunchSnapshot: vi.fn(async () => null) };
});

const TEAM_NAME = 'process-exited-status-team';
const RUN_ID = 'run-current';
const NOW = '2026-10-23T10:00:00.000Z';
const DEAD_PID = 62728;
const WORKDIR = '/safe-test-workspace/process-exited-status-team';

const confirmedStatus: MemberSpawnStatusEntry = {
  status: 'online',
  launchState: 'confirmed_alive',
  agentToolAccepted: true,
  runtimeAlive: true,
  bootstrapConfirmed: true,
  hardFailure: false,
  livenessSource: 'heartbeat',
  lastHeartbeatAt: NOW,
  updatedAt: NOW,
};

const startingStatus: MemberSpawnStatusEntry = {
  status: 'spawning',
  launchState: 'starting',
  agentToolAccepted: false,
  runtimeAlive: false,
  bootstrapConfirmed: false,
  hardFailure: false,
  updatedAt: NOW,
};

function configFor(providerId: 'anthropic' | 'opencode'): TeamConfig {
  return {
    name: TEAM_NAME,
    members: [{ name: 'DEPLOY', providerId, model: 'claude-sonnet-5-5', cwd: WORKDIR }],
  };
}

function runWith(status: MemberSpawnStatusEntry, providerId: 'anthropic' | 'opencode') {
  const member = { name: 'DEPLOY', providerId, model: 'claude-sonnet-5-5', cwd: WORKDIR };
  return {
    runId: RUN_ID,
    child: null,
    processKilled: false,
    cancelRequested: false,
    request: {
      teamName: TEAM_NAME,
      members: [member],
      cwd: WORKDIR,
      providerId,
      model: 'claude-sonnet-5-5',
    },
    effectiveMembers: [member],
    allEffectiveMembers: [member],
    memberSpawnStatuses: new Map([['DEPLOY', status]]),
  };
}

function persistedMember(
  overrides: Partial<PersistedRuntimeMemberLike> = {}
): PersistedRuntimeMemberLike {
  return {
    name: 'DEPLOY',
    providerId: 'anthropic',
    agentId: 'deploy@process-exited-status-team',
    backendType: 'process',
    tmuxPaneId: `process:${DEAD_PID}`,
    runtimePid: DEAD_PID,
    bootstrapRunId: RUN_ID,
    ...overrides,
  };
}

interface MetadataOptions {
  status: MemberSpawnStatusEntry;
  providerId?: 'anthropic' | 'opencode';
  member?: PersistedRuntimeMemberLike;
  processRows?: RuntimeTelemetryProcessTableRow[];
  alivePids: number[];
}

async function buildMetadata(
  options: MetadataOptions
): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
  const providerId = options.providerId ?? 'anthropic';
  return buildLiveTeamAgentRuntimeMetadata({
    teamName: TEAM_NAME,
    runId: RUN_ID,
    generationAtStart: 0,
    runs: new Map([[RUN_ID, runWith(options.status, providerId)]]),
    runtimeAdapterRunByTeam: new Map(),
    teamMetaStore: { getMeta: vi.fn(async () => ({ providerId })) },
    membersMetaStore: { getMembers: vi.fn(async () => []) },
    launchStateStore: { read: vi.fn(async () => null) },
    readConfigSnapshot: vi.fn(async () => configFor(providerId)),
    readPersistedRuntimeMembers: vi.fn(() => [options.member ?? persistedMember()]),
    readRuntimeProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: options.processRows ?? [],
      processTableAvailable: true,
    })),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: vi.fn(async () => ({
      rows: [],
      processTableAvailable: false,
    })),
    isRuntimePidAlive: (pid) => options.alivePids.includes(pid),
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
    getTrackedRunId: vi.fn(() => RUN_ID),
    getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
    liveRuntimeMetadataCache: { rememberLiveTeamAgentRuntimeMetadata: vi.fn() },
    logDebug: vi.fn(),
  });
}

function isStalePidAttachInput(
  statuses: Record<string, MemberSpawnStatusEntry>,
  metadata: LiveTeamAgentRuntimeMetadata
) {
  return {
    statuses,
    runtimeByMember: new Map([['DEPLOY', metadata]]),
    isOpenCodeBootstrapStallWindowElapsed: () => false,
  };
}

describe('SR-13: данные о живости участника с мёртвым pid', () => {
  it('подтверждённый участник с мёртвым pid: не жив, причина process_exited, pid назван', async () => {
    const metadata = await buildMetadata({ status: confirmedStatus, alivePids: [] });

    expect(metadata.get('DEPLOY')).toMatchObject({
      alive: false,
      livenessKind: 'stale_metadata',
      processExited: true,
      metricsPid: DEAD_PID,
    });
    expect(metadata.get('DEPLOY')?.runtimeDiagnostic).toContain('process_exited');
    expect(metadata.get('DEPLOY')?.runtimeDiagnostic).toContain(String(DEAD_PID));
  });

  it('тот же участник с живым pid и свежим heartbeat остаётся живым, без признака завершения', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const metadata = await buildMetadata({ status: confirmedStatus, alivePids: [DEAD_PID] });

      expect(metadata.get('DEPLOY')).toMatchObject({
        alive: true,
        livenessKind: 'confirmed_bootstrap',
      });
      expect(metadata.get('DEPLOY')?.processExited).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat давно устарел, pid мёртв: признак завершения ставится (статус не держится на старом подтверждении)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(NOW) + 60 * 60 * 1000));
    try {
      const metadata = await buildMetadata({ status: confirmedStatus, alivePids: [] });

      expect(metadata.get('DEPLOY')).toMatchObject({ alive: false, processExited: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('идёт запуск (подтверждения ещё нет): признак завершения не ставится', async () => {
    const metadata = await buildMetadata({ status: startingStatus, alivePids: [] });

    expect(metadata.get('DEPLOY')?.processExited).toBeUndefined();
    expect(metadata.get('DEPLOY')?.alive).toBe(false);
  });

  it('участник OpenCode: признак завершения не ставится', async () => {
    const metadata = await buildMetadata({
      status: confirmedStatus,
      providerId: 'opencode',
      member: persistedMember({ providerId: 'opencode' }),
      alivePids: [],
    });

    expect(metadata.get('DEPLOY')?.processExited).toBeUndefined();
  });

  it('участник в tmux: признак завершения не ставится', async () => {
    const metadata = await buildMetadata({
      status: confirmedStatus,
      member: persistedMember({ backendType: 'tmux', tmuxPaneId: '%3' }),
      alivePids: [],
    });

    expect(metadata.get('DEPLOY')?.processExited).toBeUndefined();
  });

  it('в таблице процессов есть процесс этого агента с другим pid: агент жив', async () => {
    const metadata = await buildMetadata({
      status: confirmedStatus,
      processRows: [
        {
          pid: 777,
          ppid: 1,
          command: `claude --team-name ${TEAM_NAME} --agent-id deploy@${TEAM_NAME}`,
        },
      ],
      alivePids: [],
    });

    expect(metadata.get('DEPLOY')).toMatchObject({ alive: true });
    expect(metadata.get('DEPLOY')?.processExited).toBeUndefined();
  });
});

describe('SR-13: разбор статусов', () => {
  const processExitedMetadata: LiveTeamAgentRuntimeMetadata = {
    alive: false,
    backendType: 'process',
    providerId: 'anthropic',
    pid: DEAD_PID,
    metricsPid: DEAD_PID,
    livenessKind: 'stale_metadata',
    pidSource: 'persisted_metadata',
    processExited: true,
    runtimeDiagnostic: `process_exited: runtime process pid ${DEAD_PID} is not running`,
    runtimeDiagnosticSeverity: 'warning',
  };

  it('подтверждённый участник становится offline, heartbeat его не оживляет', () => {
    const attached = attachLiveRuntimeMetadataToStatuses(
      isStalePidAttachInput({ DEPLOY: confirmedStatus }, processExitedMetadata)
    );

    expect(attached.DEPLOY).toMatchObject({
      status: 'offline',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      launchState: 'starting',
      livenessKind: 'stale_metadata',
    });
    expect(attached.DEPLOY.livenessSource).toBeUndefined();
    expect(attached.DEPLOY.lastHeartbeatAt).toBeUndefined();
    expect(attached.DEPLOY.runtimeDiagnostic).toContain('process_exited');
  });

  it('слабые данные без признака завершения подтверждённого участника не опускают', () => {
    const attached = attachLiveRuntimeMetadataToStatuses(
      isStalePidAttachInput(
        { DEPLOY: confirmedStatus },
        { ...processExitedMetadata, processExited: undefined }
      )
    );

    expect(attached.DEPLOY).toMatchObject({ status: 'online', runtimeAlive: true });
  });

  it('идёт запуск (spawning): статус остаётся «запускается»', () => {
    const attached = attachLiveRuntimeMetadataToStatuses(
      isStalePidAttachInput({ DEPLOY: startingStatus }, processExitedMetadata)
    );

    expect(attached.DEPLOY).toMatchObject({ status: 'spawning', runtimeAlive: false });
  });
});

describe('SR-13: снимок для тимлида', () => {
  async function snapshotFor(liveRuntime: LiveTeamAgentRuntimeMetadata) {
    return buildTeamAgentRuntimeSnapshot({
      teamName: TEAM_NAME,
      runId: RUN_ID,
      generationAtStart: 0,
      runs: new Map([[RUN_ID, runWith(confirmedStatus, 'anthropic')]]),
      runtimeAdapterRunByTeam: new Map(),
      teamMetaStore: { getMeta: vi.fn(async () => ({ providerId: 'anthropic' as const })) },
      membersMetaStore: { getMembers: vi.fn(async () => []) },
      launchStateStore: { read: vi.fn(async () => null) },
      readConfigSnapshot: vi.fn(async () => configFor('anthropic')),
      readPersistedRuntimeMembers: vi.fn(() => []),
      getMemberSpawnStatuses: vi.fn(
        async (): Promise<MemberSpawnStatusesSnapshot> => ({
          runId: RUN_ID,
          source: 'live',
          statuses: { DEPLOY: confirmedStatus },
        })
      ),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map([['DEPLOY', liveRuntime]])),
      readRuntimeProcessRowsForUsageSnapshot: vi.fn(async () => []),
      readProcessUsageStatsByPid: vi.fn(async () => new Map()),
      buildRuntimeUsageProcessTrees: vi.fn(() => new Map()),
      buildRuntimeProcessLoadStats: vi.fn(() => undefined),
      agentRuntimeResourceHistory: { record: vi.fn(() => undefined), prune: vi.fn() },
      getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
      getTrackedRunId: vi.fn(() => RUN_ID),
      getAgentRuntimeSnapshotCacheTtlMs: vi.fn(() => 1_000),
      rememberAgentRuntimeSnapshot: vi.fn(),
      logDebug: vi.fn(),
    });
  }

  it('мёртвый pid: снимок не считает участника живым, несмотря на свежий heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const snapshot = await snapshotFor({
        alive: false,
        backendType: 'process',
        providerId: 'anthropic',
        pid: DEAD_PID,
        metricsPid: DEAD_PID,
        livenessKind: 'stale_metadata',
        pidSource: 'persisted_metadata',
        processExited: true,
        runtimeDiagnostic: `process_exited: runtime process pid ${DEAD_PID} is not running`,
        runtimeDiagnosticSeverity: 'warning',
      });

      expect(snapshot.members.DEPLOY).toMatchObject({
        alive: false,
        livenessKind: 'stale_metadata',
      });
      expect(snapshot.members.DEPLOY.runtimeDiagnostic).toContain('process_exited');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('проверка pid на живом процессе (настоящий process.kill)', () => {
  it('живой процесс виден, завершённый — нет', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    try {
      expect(isProcessAlive(pid!)).toBe(true);
    } finally {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    expect(isProcessAlive(pid!)).toBe(false);
  });
});
