// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { createBoundLifecycleQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleQueries';
import { createBoundTeamLiveStatusQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundTeamLiveStatusQueries';

const now = '2026-10-30T00:00:05.000Z';

function setup() {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  const registry = new MemberLifecycleRegistry(owner);
  const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
  registry.configureTeam(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
  ]);
  const queries = createBoundLifecycleQueries({
    owner,
    source: registry,
    invalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
  const statuses = createBoundTeamLiveStatusQueries({ owner, queries, now: () => now });
  return { context, owner, registry, run, queries, statuses };
}

function ready(registry: MemberLifecycleRegistry, run: ReturnType<typeof setup>['run']) {
  const tokens = registry.beginTeamStart(run, () => 'TEST-operation');
  const token = tokens.find((entry) => entry.memberName === 'builder')!;
  const process = { pid: 123, birthId: 'TEST-birth' };
  registry.observeSpawn(token, process);
  registry.observeConnected(token);
  return { token, process };
}

describe('context-bound live team status projections', () => {
  it('projects live member statuses and runtime entries from one snapshot', async () => {
    const { registry, run, statuses } = setup();
    expect(await statuses.memberSpawnStatuses({ teamName: run.teamName })).toMatchObject({
      statuses: {
        builder: { status: 'offline', launchState: 'starting', runtimeAlive: false },
      },
      runId: run.runId,
      expectedMembers: ['builder'],
      source: 'live',
      updatedAt: now,
    });
    expect(await statuses.runtimeSnapshot({ teamName: run.teamName })).toMatchObject({
      teamName: run.teamName,
      runId: run.runId,
      members: {
        'team-lead': { alive: false, restartable: false },
        builder: { alive: false, restartable: true },
      },
    });
    ready(registry, run);
    expect(await statuses.memberSpawnStatuses({ teamName: run.teamName })).toMatchObject({
      statuses: {
        builder: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          livenessSource: 'heartbeat',
        },
      },
    });
    expect(await statuses.runtimeSnapshot({ teamName: run.teamName })).toMatchObject({
      members: { builder: { alive: true, restartable: true, pid: 123 } },
    });
  });

  it('answers an unknown team with an empty live projection', async () => {
    const { statuses } = setup();
    expect(await statuses.memberSpawnStatuses({ teamName: 'test-absent' })).toEqual({
      statuses: {},
      runId: null,
      expectedMembers: [],
      updatedAt: now,
      source: 'live',
    });
    expect(await statuses.runtimeSnapshot({ teamName: 'test-absent' })).toEqual({
      teamName: 'test-absent',
      updatedAt: now,
      runId: null,
      members: {},
    });
  });

  it('rejects a stale context and malformed team names', async () => {
    const { context, statuses } = setup();
    await context.closeAdmission();
    context.rebind('TEST-next-root');
    await expect(statuses.memberSpawnStatuses({ teamName: 'test-team' })).rejects.toThrow(
      'APP_CONTEXT_MISMATCH'
    );
    await expect(statuses.runtimeSnapshot({ teamName: 'test-team' })).rejects.toThrow(
      'APP_CONTEXT_MISMATCH'
    );
    await expect(statuses.memberSpawnStatuses({ teamName: ' test-team' })).rejects.toThrow();
    await expect(statuses.runtimeSnapshot({ teamName: '../other' })).rejects.toThrow();
  });
});
