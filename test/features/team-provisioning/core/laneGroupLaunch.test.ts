// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { MemberLaneObservation } from '../../../../src/features/team-provisioning/contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaneGroupEvents,
  MemberRuntimePort,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

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

const settingsFor = async (
  team: typeof run,
  memberName: string
): Promise<ConfiguredMemberLaunch> => ({
  team,
  memberName,
  configurationRevision: 'TEST-revision',
  providerId: 'opencode',
  model: null,
  workingDirectory: 'TEST',
  instructions: 'TEST',
});

function setup(
  options: {
    omitObservation?: string;
    stopEmitsRelease?: boolean;
    lanePlan?: readonly { laneId: string; memberNames: readonly string[] }[];
  } = {}
) {
  const stops: string[] = [];
  const inputs: { memberName: string; line: string }[] = [];
  const answers: {
    memberName: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }[] = [];
  const groups: { laneId: string; memberNames: string[]; events: MemberLaneGroupEvents | null }[] =
    [];
  const runtime: MemberRuntimePort = {
    kind: () => 'lane',
    async spawn() {
      throw new Error('process spawn must not be used for a lane group');
    },
    async startLane(settings, token, signal) {
      const group = await runtime.startLaneGroup!(
        [settings],
        [token],
        `secondary:opencode:${token.memberName}`,
        signal
      );
      return {
        lane: group.observations[token.memberName]!,
        subscribe(events) {
          return group.subscribe({
            observed: (memberName, observation) => {
              if (memberName === token.memberName) events.laneObserved?.(observation);
            },
            lost: (memberName, error) => {
              if (memberName === token.memberName) events.laneLost?.(error);
            },
            failed: (memberName, error) => {
              if (memberName === token.memberName) events.failed(error);
            },
            released: () => events.released(),
          });
        },
        stop: () => group.stop(),
        writeInput: (line) => group.writeInput(token.memberName, line),
      };
    },
    async startLaneGroup(settings, tokens, laneId) {
      const record = {
        laneId,
        memberNames: tokens.map((token) => token.memberName),
        events: null as MemberLaneGroupEvents | null,
      };
      groups.push(record);
      return {
        observations: Object.fromEntries(
          tokens
            .filter((token) => token.memberName !== options.omitObservation)
            .map((token) => [token.memberName, observation(laneId)])
        ),
        subscribe(events) {
          record.events = events;
          return () => {
            record.events = null;
          };
        },
        async writeInput(memberName, line) {
          inputs.push({ memberName, line });
        },
        async listPermissions() {
          return [{ memberName: 'team-lead', requestId: 'TEST-permission' }];
        },
        async answerPermission(input) {
          answers.push(input);
        },
        async stop() {
          stops.push(laneId);
          if (options.stopEmitsRelease === false) return;
          for (const token of tokens) record.events?.lost(token.memberName);
          record.events?.released();
        },
      };
    },
  };
  const lifecycle = createMemberLifecycle({
    owner,
    settings: { findConfiguredMember: settingsFor },
    runtime,
    laneGroups: () =>
      options.lanePlan ?? [{ laneId: 'primary', memberNames: ['team-lead', 'builder'] }],
  });
  return { lifecycle, stops, inputs, answers, groups };
}

function createWithGroups(
  laneGroups: () => readonly { laneId: string; memberNames: readonly string[] }[]
) {
  return createMemberLifecycle({
    owner,
    settings: { findConfiguredMember: settingsFor },
    runtime: {
      async spawn() {
        throw new Error('unused');
      },
    },
    laneGroups,
  });
}

describe('team lane-group launch', () => {
  it('launches the whole lane once and binds every member', async () => {
    const { lifecycle, groups } = setup();
    const receipt = await lifecycle.teams.launchConfigured(run, async () => roster);
    expect(receipt.run).toEqual(run);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ laneId: 'primary', memberNames: ['team-lead', 'builder'] });
    await lifecycle.commands.settled(run, 'team-lead');
    await lifecycle.commands.settled(run, 'builder');
    expect(lifecycle.snapshot(run.teamName).state).toBe('ready');
    expect(lifecycle.registry.aliveTeamNames()).toEqual([run.teamName]);
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'ready',
      lane: { laneId: 'primary' },
    });
  });

  it('writes input through the shared lane and stops it once', async () => {
    const { lifecycle, inputs, stops } = setup();
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'team-lead');
    const member = lifecycle.snapshot(run.teamName).members['team-lead'];
    await lifecycle.commands.writeInput(
      {
        ...run,
        memberName: 'team-lead',
        generation: member.generation,
        operationId: member.operationId!,
      },
      'TEST input'
    );
    expect(inputs).toEqual([{ memberName: 'team-lead', line: 'TEST input' }]);
    await lifecycle.teams.stop(run);
    expect(stops).toEqual(['primary']);
    expect(lifecycle.snapshot(run.teamName).state).toBe('stopped');
    expect(lifecycle.registry.aliveTeamNames()).toEqual([]);
  });

  it('applies lane observations and failures to the hosted member', async () => {
    const { lifecycle, groups } = setup();
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'builder');
    groups[0]!.events?.observed('builder', {
      ...observation('primary'),
      bootstrapConfirmed: false,
      permissionBlocked: true,
    });
    expect(lifecycle.snapshot(run.teamName).members.builder.phase).toBe('connecting');
    expect(lifecycle.snapshot(run.teamName).state).toBe('starting');
    groups[0]!.events?.failed('builder', 'TEST lane failure');
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      error: 'TEST lane failure',
    });
    expect(lifecycle.snapshot(run.teamName).state).toBe('degraded');
  });

  it('lists and answers permissions through the owning lane group', async () => {
    const { lifecycle, answers } = setup();
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'team-lead');
    await expect(lifecycle.commands.listLanePermissions({ run })).resolves.toEqual([
      { memberName: 'team-lead', requestId: 'TEST-permission' },
    ]);
    await lifecycle.commands.answerLanePermission({
      run,
      requestId: 'TEST-permission',
      allow: true,
      message: 'TEST allow',
    });
    expect(answers).toEqual([
      { memberName: 'team-lead', requestId: 'TEST-permission', allow: true, message: 'TEST allow' },
    ]);
    await expect(
      lifecycle.commands.answerLanePermission({ run, requestId: 'TEST-unknown', allow: true })
    ).rejects.toThrow('Unknown permission request');
  });

  it('restarts a single-member lane and rejects a shared lane', async () => {
    const single = setup({
      lanePlan: [{ laneId: 'secondary:opencode:builder', memberNames: ['builder'] }],
    });
    await single.lifecycle.teams.launchConfigured(run, async () => roster);
    await single.lifecycle.commands.settled(run, 'builder');
    const before = single.lifecycle.snapshot(run.teamName).members.builder;
    const admission = await single.lifecycle.commands.restart({
      ...run,
      memberName: 'builder',
      generation: before.generation,
    });
    expect(admission.kind).toBe('launch');
    await single.lifecycle.commands.settled(run, 'builder');
    const after = single.lifecycle.snapshot(run.teamName).members.builder;
    expect(after.generation).toBe(before.generation + 1);
    expect(after.phase).toBe('ready');

    const shared = setup();
    await shared.lifecycle.teams.launchConfigured(run, async () => roster);
    await shared.lifecycle.commands.settled(run, 'builder');
    const member = shared.lifecycle.snapshot(run.teamName).members.builder;
    await expect(
      shared.lifecycle.commands.restart({
        ...run,
        memberName: 'builder',
        generation: member.generation,
      })
    ).rejects.toThrow('shared adapter lane');
  });

  it('rejects a lane group that names an unconfigured or duplicated member', async () => {
    const unknown = createWithGroups(() => [
      { laneId: 'primary', memberNames: ['team-lead', 'ghost'] },
    ]);
    await expect(unknown.teams.launchConfigured(run, async () => roster)).rejects.toThrow(
      'unconfigured member'
    );
    const duplicate = createWithGroups(() => [
      { laneId: 'primary', memberNames: ['team-lead'] },
      { laneId: 'secondary:builder', memberNames: ['team-lead'] },
    ]);
    await expect(duplicate.teams.launchConfigured(run, async () => roster)).rejects.toThrow(
      'two lanes'
    );
  });

  it('fails the whole group when adapter evidence is missing for a member', async () => {
    const { lifecycle } = setup({ omitObservation: 'builder' });
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'builder');
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      error: 'Adapter lane evidence is missing for a member',
    });
    expect(lifecycle.snapshot(run.teamName).members['team-lead'].resources).toBe('released');
    expect(lifecycle.commands.hasUnreleased(run)).toBe(false);
  });

  it('treats a resolved lane stop as release even without a release event', async () => {
    const { lifecycle, stops } = setup({ stopEmitsRelease: false });
    await lifecycle.teams.launchConfigured(run, async () => roster);
    await lifecycle.commands.settled(run, 'team-lead');
    await lifecycle.teams.stop(run);
    expect(stops).toEqual(['primary']);
    expect(lifecycle.snapshot(run.teamName).state).toBe('stopped');
    expect(lifecycle.registry.aliveTeamNames()).toEqual([]);
    expect(lifecycle.commands.hasUnreleased(run)).toBe(false);
  });

  it('rejects the same lane id in two groups and a changed lane plan on retry', async () => {
    const duplicateLane = createWithGroups(() => [
      { laneId: 'primary', memberNames: ['team-lead'] },
      { laneId: 'primary', memberNames: ['builder'] },
    ]);
    await expect(duplicateLane.teams.launchConfigured(run, async () => roster)).rejects.toThrow(
      'launched only once'
    );

    let plan = [{ laneId: 'primary', memberNames: ['team-lead', 'builder'] }];
    const changing = createMemberLifecycle({
      owner,
      settings: { findConfiguredMember: settingsFor },
      runtime: {
        async spawn() {
          throw new Error('unused');
        },
      },
      laneGroups: () => plan,
    });
    await changing.teams.launchConfigured(run, async () => roster);
    plan = [{ laneId: 'secondary:builder', memberNames: ['builder'] }];
    await expect(changing.teams.launchConfigured(run, async () => roster)).rejects.toThrow(
      'lane plan cannot be changed'
    );
  });
});
