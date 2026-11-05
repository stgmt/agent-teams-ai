// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  toMemberSpawnStatuses,
  toTeamAgentRuntimeSnapshot,
  toTeamRuntimeState,
} from '../../../src/main/team-runtime/nativeTeamRuntimeProjection';
import { hasUnresolvedMemberSpawnStatus } from '../../../src/renderer/utils/memberSpawnStatusPolling';

import type {
  MemberLifecycleSnapshot,
  TeamLifecycleSnapshot,
} from '../../../src/features/team-provisioning/contracts';

const identity = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};
const now = '2026-10-30T00:00:00.000Z';
const withProcess = new Set<MemberLifecycleSnapshot['phase']>([
  'connecting',
  'ready',
  'unresponsive',
  'stopping',
  'failed',
]);

function member(
  memberName: string,
  phase: MemberLifecycleSnapshot['phase'],
  overrides: Partial<MemberLifecycleSnapshot> = {}
): MemberLifecycleSnapshot {
  return {
    memberName,
    role: memberName === 'team-lead' ? 'lead' : 'member',
    membership: 'configured',
    desired: 'running',
    phase,
    resources: 'held',
    generation: 1,
    operationId: `op-${memberName}`,
    process: withProcess.has(phase) ? { pid: 123, birthId: 'birth' } : null,
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
    ...overrides,
  };
}

function snapshot(members: MemberLifecycleSnapshot[]): TeamLifecycleSnapshot {
  return {
    identity,
    desired: 'running',
    resources: 'held',
    state: 'ready',
    error: null,
    version: 1,
    startedAt: now,
    members: Object.fromEntries(members.map((entry) => [entry.memberName, entry])),
  };
}

describe('native lifecycle projection', () => {
  it('keeps the lead in runtime entries but out of member spawn statuses', () => {
    const source = snapshot([member('team-lead', 'ready')]);
    expect(toTeamRuntimeState(source)).toEqual({
      teamName: 'TEST-team',
      isAlive: true,
      runId: 'TEST-run',
      progress: null,
    });
    expect(toTeamAgentRuntimeSnapshot(source, now).members['team-lead']).toEqual({
      memberName: 'team-lead',
      alive: true,
      restartable: false,
      backendType: 'lead',
      pid: 123,
      runtimePid: 123,
      livenessKind: 'confirmed_bootstrap',
      updatedAt: now,
    });
    const statuses = toMemberSpawnStatuses(source, now);
    expect(statuses.statuses).toEqual({});
    expect(statuses.expectedMembers).toEqual([]);
  });

  it('reports a ready teammate with heartbeat proof and restart available', () => {
    const source = snapshot([member('team-lead', 'ready'), member('worker', 'ready')]);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toEqual({
      memberName: 'worker',
      alive: true,
      restartable: true,
      backendType: 'process',
      pid: 123,
      runtimePid: 123,
      livenessKind: 'confirmed_bootstrap',
      updatedAt: now,
    });
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toEqual({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      livenessKind: 'confirmed_bootstrap',
      updatedAt: now,
    });
  });

  it('does not call a starting member alive before a process exists', () => {
    const source = snapshot([member('team-lead', 'starting')]);
    expect(toTeamRuntimeState(source).isAlive).toBe(false);
    expect(toTeamAgentRuntimeSnapshot(source, now).members['team-lead']).toEqual({
      memberName: 'team-lead',
      alive: false,
      restartable: false,
      backendType: 'lead',
      updatedAt: now,
    });
    expect(toMemberSpawnStatuses(source, now).statuses).toEqual({});
  });

  it.each(['stopped', 'exited'] as const)(
    'projects %s without a live process as stopped evidence',
    (phase) => {
      const entry = toTeamAgentRuntimeSnapshot(snapshot([member('worker', phase)]), now).members
        .worker;
      expect(entry).toMatchObject({ alive: false, livenessKind: 'not_found' });
    }
  );

  it('does not mark a terminal member stopped while its process is still owned', () => {
    const entry = toTeamAgentRuntimeSnapshot(
      snapshot([member('worker', 'stopped', { process: { pid: 123, birthId: 'birth' } })]),
      now
    ).members.worker;
    expect(entry).toMatchObject({ alive: true, livenessKind: 'runtime_process' });
  });

  it('reports a connecting teammate as a live process', () => {
    const source = snapshot([member('worker', 'connecting')]);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toMatchObject({
      alive: true,
      livenessKind: 'runtime_process',
    });
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'spawning',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: 'process',
      livenessKind: 'runtime_process',
    });
  });

  it('keeps a stopping member alive while its process is still owned', () => {
    const source = snapshot([member('worker', 'stopping')]);
    expect(toTeamRuntimeState(source).isAlive).toBe(true);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'waiting',
      runtimeAlive: true,
      launchState: 'starting',
    });
  });

  it('keeps a failed member with an owned process alive and restartable', () => {
    const source = snapshot([member('worker', 'failed', { error: 'TEST failure' })]);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toMatchObject({
      alive: true,
      restartable: true,
      runtimeDiagnostic: 'TEST failure',
      runtimeDiagnosticSeverity: 'error',
    });
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: true,
      error: 'TEST failure',
      hardFailure: true,
    });
  });

  it('marks a failed phase as an error even when no diagnostic text is available', () => {
    const source = snapshot([member('worker', 'failed')]);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toMatchObject({
      alive: true,
      runtimeDiagnosticSeverity: 'error',
    });
  });

  it('shows a skipped member as skipped and suppresses a retained cancellation error', () => {
    const source = snapshot([
      member('worker', 'stopped', {
        skippedForLaunch: true,
        desired: 'stopped',
        error: 'cancelled',
      }),
    ]);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toEqual({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      runtimeAlive: false,
      skippedForLaunch: true,
      updatedAt: now,
    });
  });

  it('marks an unresponsive process online with a warning diagnostic', () => {
    const source = snapshot([member('worker', 'unresponsive')]);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'process',
      livenessKind: 'runtime_process',
      runtimeDiagnostic: 'connection lost',
      runtimeDiagnosticSeverity: 'warning',
    });
  });

  it('excludes removed members and keeps the configured subordinate roster exact', () => {
    const source = snapshot([
      member('team-lead', 'ready'),
      member('worker', 'ready'),
      member('removed', 'stopped', { membership: 'removed' }),
    ]);
    const statuses = toMemberSpawnStatuses(source, now);
    expect(Object.keys(statuses.statuses)).toEqual(['worker']);
    expect(statuses.expectedMembers).toEqual(['worker']);
  });

  it('projects an empty roster without inventing members', () => {
    const source = snapshot([]);
    expect(toTeamRuntimeState(source).isAlive).toBe(false);
    expect(toTeamAgentRuntimeSnapshot(source, now).members).toEqual({});
    expect(toMemberSpawnStatuses(source, now)).toMatchObject({
      statuses: {},
      expectedMembers: [],
      source: 'live',
    });
  });

  it('does not poll an offline member because of the DTO launch-state placeholder', () => {
    const source = snapshot([member('worker', 'stopped')]);
    const statuses = toMemberSpawnStatuses(source, now);
    expect(statuses.statuses.worker.status).toBe('offline');
    expect(statuses.statuses.worker.launchState).toBe('starting');
    expect(hasUnresolvedMemberSpawnStatus(statuses.statuses, statuses)).toBe(false);
  });

  it('still polls a genuinely spawning member', () => {
    const source = snapshot([member('worker', 'starting')]);
    const statuses = toMemberSpawnStatuses(source, now);
    expect(hasUnresolvedMemberSpawnStatus(statuses.statuses, statuses)).toBe(true);
  });

  it('reports an adapter lane as live without inventing a member pid', () => {
    const source = snapshot([
      member('worker', 'ready', {
        process: null,
        lane: {
          laneId: 'TEST-lane',
          sessionId: 'TEST-session',
          hostPid: 900,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          permissionBlocked: false,
        },
      }),
    ]);
    expect(toTeamRuntimeState(source).isAlive).toBe(true);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toEqual({
      memberName: 'worker',
      alive: true,
      restartable: false,
      backendType: 'process',
      laneId: 'TEST-lane',
      runtimeLoadScope: 'shared-host',
      pidSource: 'opencode_bridge',
      livenessKind: 'confirmed_bootstrap',
      updatedAt: now,
    });
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toEqual({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      livenessSource: 'heartbeat',
      livenessKind: 'confirmed_bootstrap',
      updatedAt: now,
    });
  });

  it('reports a permission-blocked lane as pending, not alive', () => {
    const source = snapshot([
      member('worker', 'connecting', {
        process: null,
        lane: {
          laneId: 'TEST-lane',
          sessionId: 'TEST-session',
          hostPid: 900,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          permissionBlocked: true,
        },
      }),
    ]);
    expect(toTeamRuntimeState(source).isAlive).toBe(false);
    expect(toTeamAgentRuntimeSnapshot(source, now).members.worker).toMatchObject({
      alive: false,
      livenessKind: 'permission_blocked',
    });
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'spawning',
      launchState: 'runtime_pending_permission',
      runtimeAlive: false,
      livenessKind: 'permission_blocked',
    });
  });

  it('reports a live lane before bootstrap as a pending process', () => {
    const source = snapshot([
      member('worker', 'ready', {
        process: null,
        lane: {
          laneId: 'TEST-lane',
          sessionId: null,
          hostPid: null,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          permissionBlocked: false,
        },
      }),
    ]);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'spawning',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: 'process',
      livenessKind: 'runtime_process',
    });
  });

  it('reports a failed lane as an error, not as waiting', () => {
    const source = snapshot([
      member('worker', 'failed', {
        process: null,
        error: 'TEST lane failure',
        lane: {
          laneId: 'TEST-lane',
          sessionId: null,
          hostPid: 900,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          permissionBlocked: false,
        },
      }),
    ]);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      error: 'TEST lane failure',
      hardFailure: true,
    });
  });

  it('drops a lost lane back to offline', () => {
    const source = snapshot([
      member('worker', 'exited', { process: null, lane: null, error: 'TEST lane lost' }),
    ]);
    expect(toTeamRuntimeState(source).isAlive).toBe(false);
    expect(toMemberSpawnStatuses(source, now).statuses.worker).toMatchObject({
      status: 'offline',
      runtimeAlive: false,
    });
  });
});
