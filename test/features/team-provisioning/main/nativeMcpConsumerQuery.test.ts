// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { NativeMcpConsumerQuery } from '../../../../src/features/team-provisioning/main/adapters/output/NativeMcpConsumerQuery';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

function member(lane: boolean) {
  return {
    memberName: 'member',
    role: 'member' as const,
    lane: lane
      ? {
          laneId: 'lane-1',
          sessionId: 'session-1',
          hostPid: 42,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          permissionBlocked: false,
        }
      : null,
    process: lane ? null : { pid: 7, birthId: 'birth' },
  } as unknown as TeamLifecycleSnapshot['members'][string];
}

function snapshot(
  state: TeamLifecycleSnapshot['state'],
  members: TeamLifecycleSnapshot['members']
) {
  return {
    identity: { teamName: 'alpha', runId: 'run-alpha' },
    state,
    members,
  } as unknown as TeamLifecycleSnapshot;
}

function query(
  entries: Record<string, TeamLifecycleSnapshot>,
  configured?: Record<string, Record<string, string>>
) {
  return new NativeMcpConsumerQuery({
    runs: {
      aliveTeamNames: () => Object.keys(entries),
      find: (teamName: string) => entries[teamName] ?? null,
    },
    ...(configured
      ? {
          configuredProviders: (runId: string) =>
            configured[runId] ? new Map(Object.entries(configured[runId]!)) : null,
        }
      : {}),
  });
}

describe('native MCP consumer query', () => {
  it('reports no consumers without live runs', () => {
    expect(query({}).hasLiveOpenCodeMcpConsumers()).toBe(false);
  });

  it('reports a consumer while a lane-backed member is live', () => {
    expect(
      query({ alpha: snapshot('ready', { builder: member(true) }) }).hasLiveOpenCodeMcpConsumers()
    ).toBe(true);
  });

  it('ignores a process-only team that already settled', () => {
    expect(
      query({ alpha: snapshot('ready', { builder: member(false) }) }).hasLiveOpenCodeMcpConsumers()
    ).toBe(false);
  });

  it('keeps the bridge for a ready run whose members are still connecting', () => {
    const connecting = {
      ...member(false),
      phase: 'connecting',
    } as unknown as TeamLifecycleSnapshot['members'][string];
    expect(query({ alpha: snapshot('ready', { builder: connecting }) }).hasLiveOpenCodeMcpConsumers()).toBe(
      true
    );

    const settled = {
      ...member(false),
      phase: 'ready',
    } as unknown as TeamLifecycleSnapshot['members'][string];
    expect(query({ alpha: snapshot('ready', { builder: settled }) }).hasLiveOpenCodeMcpConsumers()).toBe(
      false
    );
  });

  it('answers for a run configured with OpenCode after its lane went away', () => {
    const settled = {
      ...member(false),
      phase: 'exited',
    } as unknown as TeamLifecycleSnapshot['members'][string];
    const runs = { alpha: snapshot('ready', { builder: settled }) };

    expect(query(runs).hasLiveOpenCodeMcpConsumers()).toBe(false);
    expect(
      query(runs, { 'run-alpha': { builder: 'opencode' } }).hasLiveOpenCodeMcpConsumers()
    ).toBe(true);
    expect(
      query(runs, { 'run-alpha': { builder: 'anthropic' } }).hasLiveOpenCodeMcpConsumers()
    ).toBe(false);
  });

  it('keeps the bridge while a launch can still resolve to OpenCode', () => {
    for (const state of ['preparing', 'starting'] as const) {
      expect(
        query({ alpha: snapshot(state, { builder: member(false) }) }).hasLiveOpenCodeMcpConsumers(),
        state
      ).toBe(true);
    }
  });

  it('stops reporting a consumer once the team is no longer alive', () => {
    const stopped = query({});
    expect(stopped.hasLiveOpenCodeMcpConsumers()).toBe(false);
  });
});
