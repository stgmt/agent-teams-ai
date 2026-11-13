// @vitest-environment node
import { createSdkRuntimePlan, rejectUnexpectedRecovery } from './nodeMemberRuntimeFixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

// One real launch spawns a child and runs a PowerShell CIM birth inspection; under parallel
// file execution on Windows that exceeds the default 15s ceiling, so the budget is explicit.
it(
  'replaces only the observed owned Node child after its OS exit and exact resource release',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-member-restart-'));
    const owner = {
      appInstanceId: 'TEST-app',
      dataRootFingerprint: 'TEST-root',
      connectionGeneration: 1,
    };
    const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
    const starts: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifecycle = createMemberLifecycle({
      owner,
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
            providerId: 'TEST-node',
            model: null,
            workingDirectory: root,
            instructions: 'TEST',
          }),
      },
      runtime: new NodeMemberRuntime(
        {
          async prepare(launch, token) {
            starts.push(launch.memberName);
            // Real SDK children remain live until the lifecycle sends an OS signal.
            return createSdkRuntimePlan('await ready();setInterval(()=>{},1000)', token, {
              cwd: root,
              dispose:
                launch.memberName === 'builder' && token.generation === 1
                  ? () => released
                  : undefined,
            });
          },
          recover: rejectUnexpectedRecovery,
        },
        (_token, operation) => operation()
      ),
    });
    try {
      await lifecycle.teams.launch(run, [
        { memberName: 'team-lead', role: 'lead' },
        { memberName: 'builder', role: 'member' },
      ]);
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).state, { timeout: 10_000 })
        .toBe('ready');
      const initial = lifecycle.snapshot(run.teamName);
      const target = {
        ...run,
        memberName: 'builder',
        generation: initial.members.builder.generation,
      };
      const restarted = lifecycle.commands.restart(target);
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members.builder.process, { timeout: 10_000 })
        .toBeNull();
      expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
        resources: 'releasing',
        desired: 'stopped',
        generation: 1,
      });
      expect(starts).toEqual(['team-lead', 'builder']);
      expect(await lifecycle.commands.start(run, 'builder')).toEqual({ kind: 'stopping' });
      release();
      await expect(restarted).resolves.toMatchObject({ kind: 'launch', token: { generation: 2 } });
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).state, { timeout: 10_000 })
        .toBe('ready');
      const current = lifecycle.snapshot(run.teamName);
      expect(current.members.builder.process?.birthId).not.toBe(
        initial.members.builder.process?.birthId
      );
      expect(current.members['team-lead']).toEqual(initial.members['team-lead']);
      expect(starts).toEqual(['team-lead', 'builder', 'builder']);
      await expect(lifecycle.commands.restart(target)).rejects.toThrow('generation');
      expect(lifecycle.snapshot(run.teamName)).toEqual(current);
    } finally {
      release();
      try {
        if (lifecycle.registry.findSnapshot(run.teamName)) await lifecycle.teams.stop(run);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    }
  }
);
