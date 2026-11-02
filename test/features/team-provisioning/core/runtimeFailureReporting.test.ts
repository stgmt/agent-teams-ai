// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { MemberLaneObservation } from '../../../../src/features/team-provisioning/contracts';
import type { MemberRuntimePort } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };
const roster = [
  { memberName: 'team-lead', role: 'lead' as const },
  { memberName: 'builder', role: 'member' as const },
];

const observation = (laneId: string): MemberLaneObservation => ({
  laneId,
  sessionId: `session-${laneId}`,
  hostPid: 900,
  runtimeAlive: true,
  bootstrapConfirmed: true,
  permissionBlocked: false,
});

function setup(): {
  lifecycle: ReturnType<typeof createMemberLifecycle>;
  fail: (memberName: string, error: string) => void;
  reportRuntimeFailure: ReturnType<typeof vi.fn>;
} {
  let laneEvents: { failed?: (memberName: string, error: string) => void } | null = null;
  const reportRuntimeFailure = vi.fn();
  const runtime: MemberRuntimePort = {
    kind: () => 'lane',
    async spawn() {
      throw new Error('process spawn must not be used for a lane group');
    },
    async startLaneGroup(_settings, tokens, laneId) {
      return {
        observations: Object.fromEntries(
          tokens.map((token) => [token.memberName, observation(laneId)])
        ),
        subscribe(events) {
          laneEvents = events as never;
          return () => {
            laneEvents = null;
          };
        },
        async writeInput() {
          return undefined;
        },
        async stop() {
          return undefined;
        },
      };
    },
  };
  const lifecycle = createMemberLifecycle({
    owner,
    settings: {
      findConfiguredMember: async (team, memberName) => ({
        team,
        memberName,
        role: memberName === 'team-lead' ? ('lead' as const) : ('member' as const),
        configurationRevision: 'TEST-revision',
        providerId: 'opencode',
        model: null,
        workingDirectory: 'TEST',
        instructions: 'TEST',
      }),
      admitConfiguredMember: async () => undefined,
    },
    runtime,
    laneGroups: () => [{ laneId: 'primary', memberNames: ['team-lead', 'builder'] }],
    registerConfiguredMember: async () => undefined,
    reportRuntimeFailure,
  });
  return {
    lifecycle,
    reportRuntimeFailure,
    fail: (memberName, error) =>
      (laneEvents as { failed?: (name: string, message: string) => void } | null)?.failed?.(
        memberName,
        error
      ),
  };
}

describe('runtime failure reporting', () => {
  it('reports a member runtime failure once the lane reports it', async () => {
    const { lifecycle, fail, reportRuntimeFailure } = setup();
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'team-lead');
    await lifecycle.commands.settled(run, 'builder');

    fail('builder', 'provider exploded');

    expect(reportRuntimeFailure).toHaveBeenCalledWith({
      teamName: 'TEST-team',
      memberName: 'builder',
      runId: 'TEST-run',
      detail: 'provider exploded',
    });
  });

  it('stays silent when no reporter was given', async () => {
    const lifecycle = createMemberLifecycle({
      owner,
      settings: {
        findConfiguredMember: async (team, memberName) => ({
          team,
          memberName,
          role: 'lead' as const,
          configurationRevision: 'TEST-revision',
          providerId: 'opencode',
          model: null,
          workingDirectory: 'TEST',
          instructions: 'TEST',
        }),
      },
      runtime: {
        async spawn() {
          throw new Error('unused');
        },
      },
      laneGroups: () => [],
    });

    expect(lifecycle.registry.aliveTeamNames()).toEqual([]);
  });
});
