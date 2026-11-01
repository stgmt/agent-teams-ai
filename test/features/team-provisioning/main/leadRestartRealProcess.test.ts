// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { NodeMemberLaunchPlan } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
const LIVES = 'setInterval(() => {}, 1000)';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Real children: this proves termination against the OS, not against a handle we invented. */
function realRuntime() {
  return new NodeMemberRuntime(
    {
      prepare(settings): Promise<NodeMemberLaunchPlan> {
        return Promise.resolve({
          executable: process.execPath,
          args: ['-e', LIVES],
          cwd: settings.workingDirectory,
          env: process.env,
        });
      },
      observeOutput: () => 'connected',
    },
    (_token, operation) => operation()
  );
}

function lifecycleWith(runtime: NodeMemberRuntime) {
  return createMemberLifecycle({
    owner,
    runtime,
    settings: {
      findConfiguredMember: (team, memberName) =>
        Promise.resolve({
          team,
          memberName,
          role: memberName === 'team-lead' ? ('lead' as const) : ('member' as const),
          configurationRevision: 'TEST-revision',
          providerId: 'anthropic',
          model: 'TEST-model',
          workingDirectory: process.cwd(),
          instructions: 'TEST',
        }),
    },
  });
}

describe('lead restart against real processes', () => {
  it('kills the process it owned and runs the replacement instead', async () => {
    const lifecycle = lifecycleWith(realRuntime());
    await lifecycle.teams.launch(run, [
      { memberName: 'team-lead', role: 'lead' },
      { memberName: 'builder', role: 'member' },
    ]);
    await Promise.all(['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name)));

    const before = lifecycle.snapshot(run.teamName).members['team-lead']!.process!;
    expect(alive(before.pid)).toBe(true);

    await lifecycle.commands.restartLeadWithSettings({
      team: run,
      memberName: 'team-lead',
      generation: 1,
      expectedRunId: run.runId,
      overrides: { model: 'TEST-model-2', effort: 'high', resumeSessionId: 'TEST-session' },
    });
    await lifecycle.commands.settled(run, 'team-lead');

    const after = lifecycle.snapshot(run.teamName).members['team-lead']!.process!;
    expect(after.pid).not.toBe(before.pid);
    expect(alive(after.pid)).toBe(true);
    await expect.poll(() => alive(before.pid)).toBe(false);

    await lifecycle.commands.cancelPendingLaunches();
    expect(alive(after.pid)).toBe(false);
  });
});
