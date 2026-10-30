// @vitest-environment node
import { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

it.each(['stop', 'shutdown'] as const)(
  'keeps the same process and run owned after a %s termination deadline until an exact retry releases them',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-termination-lifecycle-'));
    const context = new BoundControlContext('TEST-app', root);
    const owner = context.snapshot();
    const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
    const prepare = vi.fn(() =>
      Promise.resolve({
        executable: process.execPath,
        args: ['-e', "console.log('TEST-ready');setInterval(()=>{},1000)"],
        cwd: root,
        env: process.env,
        observeOutput: (line: string) => (line === 'TEST-ready' ? ('connected' as const) : null),
      })
    );
    const runtime = new NodeMemberRuntime(
      { prepare },
      async (expected, operation) => {
        const release = context.admit(expected);
        try {
          return await operation();
        } finally {
          release();
        }
      },
      { gracePeriodMs: 25, forceExitTimeoutMs: 25 }
    );
    const lifecycle = createMemberLifecycle({
      owner,
      runtime,
      settings: {
        findConfiguredMember: (team, memberName) =>
          Promise.resolve({
            team,
            memberName,
            configurationRevision: 'TEST-revision',
            providerId: 'TEST-node-process',
            model: null,
            workingDirectory: root,
            instructions: 'TEST',
          }),
      },
    });
    let restoreSignals: (() => void) | undefined;
    let forceOwnedExit: (() => void) | undefined;
    try {
      await lifecycle.teams.launch(run, [{ memberName: 'team-lead', role: 'lead' }]);
      await lifecycle.commands.settled(run, 'team-lead');
      await expect
        .poll(() => lifecycle.snapshot(run.teamName).members['team-lead'].phase)
        .toBe('ready');
      const identity = lifecycle.snapshot(run.teamName).members['team-lead'].process!;
      const kill = ChildProcess.prototype.kill;
      // РИСК: only this synthetic child's signals are withheld to exercise timeout ownership.
      // This does not prove Windows refusal handling or descendant/crash containment.
      const signals = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
        this: ChildProcess,
        signal
      ) {
        if (this.pid !== identity.pid) return kill.call(this, signal);
        forceOwnedExit = () => {
          if (this.exitCode === null && this.signalCode === null) kill.call(this, 'SIGKILL');
        };
        return true;
      });
      restoreSignals = () => signals.mockRestore();
      const stop = () =>
        operation === 'stop' ? lifecycle.teams.stop(run) : lifecycle.teams.shutdown();
      await expect(stop()).rejects.toThrow(
        operation === 'stop' ? 'Owned member termination failed' : 'shutdown'
      );
      const blocked = lifecycle.snapshot(run.teamName);
      expect(blocked.desired).toBe('stopped');
      expect(blocked.resources).toBe('release-failed');
      expect(blocked.members['team-lead']).toMatchObject({
        desired: 'stopped',
        phase: 'stopping',
        resources: 'held',
        process: identity,
        error: expect.stringContaining('termination deadline'),
      });
      await expect(
        lifecycle.teams.launch(run, [{ memberName: 'team-lead', role: 'lead' }])
      ).rejects.toThrow(operation === 'stop' ? 'resources were not released' : 'closed');
      await expect(
        lifecycle.teams.launch({ ...run, runId: 'TEST-successor' }, [
          { memberName: 'team-lead', role: 'lead' },
        ])
      ).rejects.toThrow(operation === 'stop' ? 'resources were not released' : 'closed');
      expect(prepare).toHaveBeenCalledOnce();
      expect(lifecycle.snapshot(run.teamName).identity).toEqual(run);
      restoreSignals();
      restoreSignals = undefined;
      await stop();
      const stopped = lifecycle.snapshot(run.teamName);
      expect(stopped.resources).toBe('released');
      expect(stopped.members['team-lead']).toMatchObject({
        process: null,
        phase: 'stopped',
        resources: 'released',
      });
      expect(prepare).toHaveBeenCalledOnce();
    } finally {
      restoreSignals?.();
      forceOwnedExit?.();
      await lifecycle.teams.stop(run).catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }
);
