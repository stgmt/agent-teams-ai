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
  return { identity: { teamName: 'alpha' }, state, members } as unknown as TeamLifecycleSnapshot;
}

function query(entries: Record<string, TeamLifecycleSnapshot>) {
  return new NativeMcpConsumerQuery({
    runs: {
      aliveTeamNames: () => Object.keys(entries),
      find: (teamName: string) => entries[teamName] ?? null,
    },
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
