// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildLeadRuntimeResumeArgs } from '../../../../src/features/team-provisioning/core/domain/leadRuntimeResumeArgs';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type {
  ConfiguredMemberLaunch,
  MemberRuntimeEvents,
  MemberRuntimePort,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };

async function setup() {
  const launches: ConfiguredMemberLaunch[] = [];
  const stops: number[] = [];
  const listeners: MemberRuntimeEvents[] = [];
  const runtime: MemberRuntimePort = {
    async spawn(settings) {
      const index = launches.length;
      launches.push({ ...settings });
      return {
        identity: { pid: 200 + index, birthId: `TEST-birth-${index}` },
        writeInput: () => Promise.resolve(),
        subscribe(listener) {
          listeners[index] = listener;
          listener.connected();
          return () => undefined;
        },
        stop() {
          stops.push(index);
          listeners[index].exited({ code: 0, signal: null });
          listeners[index].released();
          return Promise.resolve();
        },
      };
    },
  };
  const lifecycle = createMemberLifecycle({
    owner,
    runtime,
    settings: {
      findConfiguredMember: (team, memberName) =>
        Promise.resolve({
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          specIntegration: {
            scope: { projects: ['TEST/project'], bindings: [] },
            environment: {
              OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
              OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
            },
          },
          providerId: 'anthropic',
          model: 'TEST-model',
          effort: 'low',
          workingDirectory: 'TEST-workspace',
          instructions: 'TEST',
        }),
    },
  });
  await lifecycle.teams.launch(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
  ]);
  await Promise.all(['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name)));
  return { lifecycle, launches, stops };
}

describe('lead restart with new launch settings', () => {
  it('resumes the captured session with the new model and effort', async () => {
    const { lifecycle, launches } = await setup();

    const admission = await lifecycle.commands.restartLeadWithSettings({
      team: run,
      memberName: 'team-lead',
      generation: 1,
      expectedRunId: run.runId,
      overrides: { model: 'TEST-model-2', effort: 'high', resumeSessionId: 'TEST-session' },
    });
    await lifecycle.commands.settled(run, 'team-lead');

    expect(admission.kind).toBe('launch');
    expect(launches).toHaveLength(3);
    expect(launches[2]).toMatchObject({
      memberName: 'team-lead',
      model: 'TEST-model-2',
      effort: 'high',
      resumeSessionId: 'TEST-session',
      team: { runId: run.runId },
    });
    expect(lifecycle.snapshot(run.teamName).members['team-lead']).toMatchObject({
      phase: 'ready',
      generation: 2,
    });
  });

  it('leaves the running lead untouched when the caller lost the run', async () => {
    const { lifecycle, launches, stops } = await setup();

    await expect(
      lifecycle.commands.restartLeadWithSettings({
        team: run,
        memberName: 'team-lead',
        generation: 1,
        expectedRunId: 'TEST-other-run',
        overrides: { model: 'TEST-model-2' },
      })
    ).rejects.toThrow('Lead run owner changed');

    expect(stops).toEqual([]);
    expect(launches).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName).members['team-lead']).toMatchObject({
      generation: 1,
      phase: 'ready',
    });
  });

  it('does not hand the overrides to a later restart of the same member', async () => {
    const { lifecycle, launches } = await setup();

    await lifecycle.commands.restartLeadWithSettings({
      team: run,
      memberName: 'team-lead',
      generation: 1,
      expectedRunId: run.runId,
      overrides: { model: 'TEST-model-2', effort: 'high', resumeSessionId: 'TEST-session' },
    });
    await lifecycle.commands.settled(run, 'team-lead');
    const restarted = lifecycle.snapshot(run.teamName).members['team-lead'];
    await lifecycle.commands.restartLeadWithSettings({
      team: run,
      memberName: 'team-lead',
      generation: restarted.generation,
      expectedRunId: run.runId,
      overrides: {},
    });
    await lifecycle.commands.settled(run, 'team-lead');

    expect(launches[3]).toMatchObject({ model: 'TEST-model', effort: 'low' });
    expect(launches[3]?.resumeSessionId).toBeUndefined();
  });
});

describe('resume arguments', () => {
  it('drops the previous model and effort and appends the resumed ones', () => {
    expect(
      buildLeadRuntimeResumeArgs({
        previousArgs: ['--print', '--model', 'old-model', '--effort=low', '--verbose'],
        sessionId: 'TEST-session',
        model: 'new-model',
        effort: 'high',
      })
    ).toEqual([
      '--print',
      '--verbose',
      '--resume',
      'TEST-session',
      '--model',
      'new-model',
      '--effort',
      'high',
    ]);
  });

  it('keeps the previous flags that the restart does not own', () => {
    expect(
      buildLeadRuntimeResumeArgs({
        previousArgs: ['--print', '--dangerously-skip-permissions', '--model', 'old-model'],
        sessionId: 'TEST-session',
        model: null,
        effort: null,
      })
    ).toEqual(['--print', '--dangerously-skip-permissions', '--resume', 'TEST-session']);
  });
});
