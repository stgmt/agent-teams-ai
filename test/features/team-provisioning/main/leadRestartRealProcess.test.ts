// @vitest-environment node
import { createSdkRuntimePlan, rejectUnexpectedRecovery } from './nodeMemberRuntimeFixture';
import { describe, expect, it } from 'vitest';

import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
// The real child remains alive until the lifecycle terminates its exact PID.
const LIVES = 'await ready();setInterval(() => {}, 1000)';

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
      async prepare(settings, token) {
        return createSdkRuntimePlan(LIVES, token, { cwd: settings.workingDirectory });
      },
      recover: rejectUnexpectedRecovery,
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
          specIntegration: {
            scope: { projects: ['TEST/project'], bindings: [] },
            environment: {
              OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
              OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
            },
          },
          providerId: 'anthropic',
          model: 'TEST-model',
          workingDirectory: process.cwd(),
          instructions: 'TEST',
        }),
    },
  });
}

describe('lead restart against real processes', () => {
  // Two real launches (lead + member) and a fenced restart; under parallel file execution on
  // Windows this exceeds the default 15s ceiling, so the budget is explicit.
  it(
    'kills the process it owned and runs the replacement instead',
    { timeout: 30_000 },
    async () => {
      const lifecycle = lifecycleWith(realRuntime());
      await lifecycle.teams.launch(run, [
        { memberName: 'team-lead', role: 'lead' },
        { memberName: 'builder', role: 'member' },
      ]);
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );

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
    }
  );
});
