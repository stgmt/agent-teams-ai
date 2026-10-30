// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { toTeamProvisioningProgress } from '../../../src/main/team-runtime/nativeTeamProgressProjection';

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
const startedAt = '2026-10-30T00:00:00.000Z';
const now = '2026-10-30T00:00:05.000Z';

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
    process: phase === 'ready' ? { pid: 123, birthId: 'birth' } : null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
    ...overrides,
  };
}

function snapshot(
  state: TeamLifecycleSnapshot['state'],
  members: MemberLifecycleSnapshot[],
  overrides: Partial<TeamLifecycleSnapshot> = {}
): TeamLifecycleSnapshot {
  return {
    identity,
    desired: 'running',
    resources: 'held',
    state,
    error: null,
    version: 1,
    members: Object.fromEntries(members.map((entry) => [entry.memberName, entry])),
    ...overrides,
  };
}

const times = { startedAt, now };

describe('native lifecycle provisioning progress', () => {
  it('reports preparation as configuring without claiming config readiness', () => {
    const progress = toTeamProvisioningProgress(
      snapshot('preparing', [], { resources: 'preparing' }),
      times
    );
    expect(progress).toEqual({
      runId: identity.runId,
      teamName: identity.teamName,
      state: 'configuring',
      message: 'Preparing team run',
      startedAt,
      updatedAt: now,
    });
  });

  it('reports an in-flight roster as spawning', () => {
    expect(
      toTeamProvisioningProgress(
        snapshot('starting', [member('team-lead', 'connecting'), member('worker', 'starting')]),
        times
      )
    ).toMatchObject({ state: 'spawning', message: 'Starting team members' });
  });

  it('reports a fully ready roster as ready and config-ready', () => {
    expect(
      toTeamProvisioningProgress(
        snapshot('ready', [member('team-lead', 'ready'), member('worker', 'ready')]),
        times
      )
    ).toMatchObject({ state: 'ready', configReady: true, message: 'Team is running' });
  });

  it('reports degraded membership as ready with sorted warnings', () => {
    const progress = toTeamProvisioningProgress(
      snapshot('degraded', [
        member('team-lead', 'ready'),
        member('zeta', 'failed', { error: 'TEST failure' }),
        member('alpha', 'exited'),
        member('skipped', 'stopped', { skippedForLaunch: true }),
      ]),
      times
    );
    expect(progress).toMatchObject({
      state: 'ready',
      messageSeverity: 'warning',
      warnings: ['alpha', 'zeta'],
      configReady: true,
    });
    expect(progress.message).toBe('Team is running; unavailable: alpha, zeta');
  });

  it('reports a failed team with the lifecycle error', () => {
    expect(
      toTeamProvisioningProgress(
        snapshot('failed', [member('team-lead', 'failed', { error: 'TEST failure' })], {
          error: 'TEST failure',
        }),
        times
      )
    ).toMatchObject({
      state: 'failed',
      message: 'TEST failure',
      error: 'TEST failure',
      messageSeverity: 'error',
    });
  });

  it('reports a failed team without inventing an error string', () => {
    const progress = toTeamProvisioningProgress(snapshot('failed', []), times);
    expect(progress.state).toBe('failed');
    expect(progress.error).toBeUndefined();
  });

  it('reports release failure as a failed run', () => {
    expect(
      toTeamProvisioningProgress(
        snapshot('release-failed', [], { resources: 'release-failed', error: 'TEST release' }),
        times
      )
    ).toMatchObject({ state: 'failed', error: 'TEST release', messageSeverity: 'error' });
  });

  it('reports stopping and stopped as a user stop', () => {
    const stopping = toTeamProvisioningProgress(
      snapshot('stopping', [], { desired: 'stopped', resources: 'releasing' }),
      times
    );
    expect(stopping).toMatchObject({
      state: 'disconnected',
      disconnect: { kind: 'user_stop' },
    });
    const stopped = toTeamProvisioningProgress(
      snapshot('stopped', [], { desired: 'stopped', resources: 'released' }),
      times
    );
    expect(stopped).toMatchObject({ state: 'disconnected', disconnect: { kind: 'user_stop' } });
  });

  it('keeps run identity and timestamps exactly as observed', () => {
    const progress = toTeamProvisioningProgress(snapshot('ready', [member('team-lead', 'ready')]), {
      startedAt,
      now,
    });
    expect(progress.runId).toBe('TEST-run');
    expect(progress.teamName).toBe('TEST-team');
    expect(progress.startedAt).toBe(startedAt);
    expect(progress.updatedAt).toBe(now);
  });
});
