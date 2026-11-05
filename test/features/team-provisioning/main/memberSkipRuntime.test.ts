// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

it('skips a failed owned Node startup only after real OS exit and exact resource release, leaving the lead alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-member-skip-'));
  const owner = {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: 'TEST-root',
    connectionGeneration: 1,
  };
  const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
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
          providerId: 'TEST-node',
          model: null,
          workingDirectory: root,
          instructions: 'TEST',
        }),
    },
    runtime: new NodeMemberRuntime(
      {
        prepare(launch) {
          // РИСК: real Node exit/cleanup verifies ownership, not native model CLI or provider acceptance.
          return Promise.resolve({
            executable: process.execPath,
            args: [
              '-e',
              launch.memberName === 'builder'
                ? 'process.exit(1)'
                : "console.log('TEST-ready');setInterval(()=>{},1000)",
            ],
            cwd: root,
            env: process.env,
            dispose: launch.memberName === 'builder' ? () => released : undefined,
          });
        },
        observeOutput: (line) => (line === 'TEST-ready' ? 'connected' : null),
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
      .poll(() => lifecycle.snapshot(run.teamName).members['team-lead'].phase, { timeout: 10_000 })
      .toBe('ready');
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.resources, { timeout: 10_000 })
      .toBe('releasing');
    const before = lifecycle.snapshot(run.teamName);
    const target = { ...run, memberName: 'builder', generation: before.members.builder.generation };
    expect(before.members.builder).toMatchObject({
      process: null,
      exit: { code: 1, signal: null },
      everConnected: false,
    });
    await expect(lifecycle.commands.skip(target)).rejects.toThrow('resources are not released');
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
    release();
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.resources, { timeout: 10_000 })
      .toBe('released');
    await lifecycle.commands.skip(target);
    const skipped = lifecycle.snapshot(run.teamName);
    expect(skipped.state).toBe('ready');
    expect(skipped.members.builder).toMatchObject({
      membership: 'configured',
      skippedForLaunch: true,
      process: null,
      exit: { code: 1, signal: null },
    });
    expect(skipped.members['team-lead']).toEqual(before.members['team-lead']);
    expect(lifecycle.registry.recoveryCandidates(run.teamName)).toEqual([]);
  } finally {
    release();
    try {
      if (lifecycle.registry.findSnapshot(run.teamName)) await lifecycle.teams.stop(run);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
});
