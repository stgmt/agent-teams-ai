// @vitest-environment node
import { createSdkRuntimePlan, rejectUnexpectedRecovery } from './nodeMemberRuntimeFixture';
import { afterEach, describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

const context = new BoundControlContext('TEST-app', 'TEST-root');
const owner = context.snapshot();
const run = { ...owner, teamName: 'TEST-process-team', runId: 'TEST-run' };
const roster = [
  { memberName: 'team-lead', role: 'lead' as const },
  { memberName: 'builder', role: 'member' as const },
];
const lifecycles: ReturnType<typeof createMemberLifecycle>[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.teams.stop(run)));
});

describe('team lifecycle with owned operating-system processes', () => {
  it.each(['registration', 'resource-release'])(
    'retains a %s failure in the authoritative snapshot after the owned process exits',
    async (stage) => {
      const lifecycle = createMemberLifecycle({
        owner,
        settings: {
          findConfiguredMember(team, memberName) {
            return Promise.resolve({
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
              providerId: 'TEST-node',
              model: null,
              workingDirectory: process.cwd(),
              instructions: 'TEST',
            });
          },
        },
        runtime: new NodeMemberRuntime(
          {
            async prepare(launch, token) {
              const member = launch.memberName === 'builder';
              return createSdkRuntimePlan(
                member && stage === 'resource-release' ? 'await finish(0)' : 'await ready()',
                token,
                {
                  afterSpawn: () =>
                    member && stage === 'registration'
                      ? Promise.reject(new Error('TEST-registration'))
                      : Promise.resolve(),
                  dispose: () =>
                    member && stage === 'resource-release'
                      ? Promise.reject(new Error('TEST-resource-release'))
                      : Promise.resolve(),
                }
              );
            },
            recover: rejectUnexpectedRecovery,
          },
          async (expected, operation) => {
            const release = context.admit(expected);
            try {
              return await operation();
            } finally {
              release();
            }
          }
        ),
      });
      lifecycles.push(lifecycle);
      await lifecycle.teams.launch(run, roster);
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members.builder.error, { timeout: 10_000 })
        .toBe(`TEST-${stage}`);
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members.builder.process, { timeout: 10_000 })
        .toBeNull();
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members.builder.resources, { timeout: 10_000 })
        .toBe(stage === 'resource-release' ? 'release-failed' : 'released');
      expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
        phase: 'failed',
        resources: stage === 'resource-release' ? 'release-failed' : 'released',
      });
      if (stage === 'resource-release') {
        expect(lifecycle.snapshot(run.teamName).state).toBe('release-failed');
        expect(lifecycle.registry.recoveryCandidates(run.teamName)).not.toContain('builder');
      }
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members['team-lead'].process, {
          timeout: 20_000,
        })
        .not.toBeNull();
      if (stage === 'resource-release') {
        expect((await lifecycle.commands.start(run, 'builder')).kind).toBe('stopping');
        await expect(lifecycle.teams.stop(run)).rejects.toThrow('termination');
        lifecycles.splice(lifecycles.indexOf(lifecycle), 1);
        await expect(
          lifecycle.teams.launch({ ...run, runId: 'TEST-next' }, roster)
        ).rejects.toThrow('released');
      }
    }
  );

  it('can finish intentional stop after a runtime failure when the exact child exits and its resources release', async () => {
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    let rejectRegistration!: (error: Error) => void;
    const registration = new Promise<void>((_resolve, reject) => {
      rejectRegistration = reject;
    });
    const lifecycle = createMemberLifecycle({
      owner,
      settings: {
        findConfiguredMember(team, memberName) {
          return Promise.resolve({
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
            providerId: 'TEST-node',
            model: null,
            workingDirectory: process.cwd(),
            instructions: 'TEST',
          });
        },
      },
      runtime: new NodeMemberRuntime(
        {
          async prepare(launch, token) {
            return createSdkRuntimePlan('await ready()', token, {
              afterSpawn:
                launch.memberName === 'builder'
                  ? async () => {
                      registrationStarted();
                      await registration;
                    }
                  : undefined,
            });
          },
          recover: rejectUnexpectedRecovery,
        },
        async (expected, operation) => {
          const release = context.admit(expected);
          try {
            return await operation();
          } finally {
            release();
          }
        }
      ),
    });
    lifecycles.push(lifecycle);
    await lifecycle.teams.launch(run, roster);
    await started;
    rejectRegistration(new Error('TEST runtime registration refused'));
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.error)
      .toBe('TEST runtime registration refused');
    await expect(lifecycle.teams.stop(run)).resolves.toBeUndefined();
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    expect(lifecycle.snapshot(run.teamName).members.builder.error).toBe(
      'TEST runtime registration refused'
    );
  });

  it('restarts only an exited configured member, keeps the lead, and never reuses historical readiness', async () => {
    const spawns = new Map<string, number>();
    const lifecycle = createMemberLifecycle({
      owner,
      settings: {
        findConfiguredMember(team, memberName) {
          return Promise.resolve({
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
            providerId: 'TEST-node',
            model: null,
            workingDirectory: process.cwd(),
            instructions: 'TEST',
          });
        },
      },
      runtime: new NodeMemberRuntime(
        {
          async prepare(settings, token) {
            const generation = (spawns.get(settings.memberName) ?? 0) + 1;
            spawns.set(settings.memberName, generation);
            return createSdkRuntimePlan(
              settings.memberName === 'builder' && generation === 1
                ? 'await ready();await finish(7)'
                : 'await ready()',
              token
            );
          },
          recover: rejectUnexpectedRecovery,
        },
        async (expected, operation) => {
          const release = context.admit(expected);
          try {
            return await operation();
          } finally {
            release();
          }
        }
      ),
    });
    lifecycles.push(lifecycle);
    const snapshots: ReturnType<typeof lifecycle.snapshot>[] = [];
    const feed = lifecycle.watch(run.teamName);
    const observing = (async () => {
      for await (const snapshot of feed) snapshots.push(snapshot);
    })();
    const admission = await lifecycle.teams.launch(run, roster);
    // This scenario verifies OS observations, not startup latency under parallel test load.
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.phase, { timeout: 10_000 })
      .toBe('exited');
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members['team-lead'].phase, { timeout: 10_000 })
      .toBe('ready');
    const first = lifecycle.snapshot(run.teamName);
    expect(first.members.builder).toMatchObject({ everConnected: true, process: null });
    const leadProcess = first.members['team-lead'].process;
    const [start, repeated] = await Promise.all([
      lifecycle.leadStart.execute(admission.leadCredential, { memberName: 'builder' }),
      lifecycle.leadStart.execute(admission.leadCredential, { memberName: 'builder' }),
    ]);
    expect(start.kind).toBe('launch');
    expect(repeated.kind).toBe('pending');
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.phase, { timeout: 10_000 })
      .toBe('ready');
    expect(lifecycle.snapshot(run.teamName).members['team-lead'].process).toEqual(leadProcess);
    expect(spawns).toEqual(
      new Map([
        ['team-lead', 1],
        ['builder', 2],
      ])
    );
    await lifecycle.teams.stop(run);
    expect(
      Object.values(lifecycle.snapshot(run.teamName).members).every(
        (member) => member.phase === 'stopped' && member.process === null
      )
    ).toBe(true);
    expect(lifecycle.registry.recoveryCandidates(run.teamName)).toEqual([]);
    await expect.poll(() => snapshots.at(-1)?.state).toBe('stopped');
    expect(
      snapshots.some(
        (snapshot) =>
          snapshot.members.builder?.phase === 'exited' &&
          snapshot.members.builder.process === null &&
          snapshot.members.builder.everConnected
      )
    ).toBe(true);
    expect(
      snapshots.every(
        (snapshot, index) => index === 0 || snapshot.version > snapshots[index - 1].version
      )
    ).toBe(true);
    expect(snapshots.at(-1)).toEqual(lifecycle.snapshot(run.teamName));
    await feed.return();
    await observing;
    await expect(
      lifecycle.leadStart.execute(admission.leadCredential, { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
  });
});
