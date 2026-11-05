// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { NodeMemberLaunchPlan } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

it('drains only its real owned Node processes and their cleanup while another owner remains live', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-lifecycle-shutdown-'));
  const context = new BoundControlContext('TEST-shutdown-owner', root);
  const owner = context.snapshot();
  const run = { ...owner, teamName: 'test-owned', runId: 'TEST-owned-run' };
  const other = new BoundControlContext('TEST-other-owner', root);
  const otherRun = { ...other.snapshot(), teamName: 'test-other', runId: 'TEST-other-run' };
  const disposed = vi.fn();
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const create = (binding: BoundControlContext, held: boolean) =>
    createMemberLifecycle({
      owner: binding.snapshot(),
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
          prepare: () =>
            Promise.resolve({
              executable: process.execPath,
              args: [
                '-e',
                "console.log('TEST-ready');process.stdin.on('data',()=>console.log('TEST-input'));setInterval(()=>{},1000)",
              ],
              cwd: root,
              env: process.env,
              observeOutput: (line: string) =>
                line === 'TEST-ready' ? ('connected' as const) : null,
              dispose: held
                ? async () => {
                    disposed();
                    await cleanup;
                  }
                : undefined,
            }),
        },
        async (expected, operation) => {
          const release = binding.admit(expected);
          try {
            return await operation();
          } finally {
            release();
          }
        }
      ),
    });
  const lifecycle = create(context, true);
  const unrelated = create(other, false);
  try {
    await lifecycle.teams.launch(run, [
      { memberName: 'team-lead', role: 'lead' },
      { memberName: 'builder', role: 'member' },
    ]);
    await unrelated.teams.launch(otherRun, [{ memberName: 'team-lead', role: 'lead' }]);
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).state, { timeout: 10_000 })
      .toBe('ready');
    await expect
      .poll(() => unrelated.snapshot(otherRun.teamName).state, { timeout: 10_000 })
      .toBe('ready');
    const otherBefore = unrelated.snapshot(otherRun.teamName);
    const closing = lifecycle.teams.shutdown();
    let complete = false;
    const drained = closing.then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(complete).toBe(false);
    const stopping = lifecycle.snapshot(run.teamName);
    expect(stopping.desired).toBe('stopped');
    expect(Object.values(stopping.members).every((member) => member.process === null)).toBe(true);
    expect(stopping.resources).toBe('releasing');
    expect(unrelated.snapshot(otherRun.teamName)).toEqual(otherBefore);
    const lead = otherBefore.members['team-lead'];
    await unrelated.commands.writeInput(
      {
        ...otherRun,
        memberName: lead.memberName,
        generation: lead.generation,
        operationId: lead.operationId!,
      },
      'TEST still owned'
    );
    finishCleanup();
    await drained;
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    expect(
      Object.values(lifecycle.snapshot(run.teamName).members).every(
        (member) => member.resources === 'released'
      )
    ).toBe(true);
    await expect(lifecycle.commands.start(run, 'builder')).rejects.toThrow('closed');
    expect(unrelated.snapshot(otherRun.teamName)).toEqual(otherBefore);
  } finally {
    finishCleanup();
    await Promise.all([lifecycle.teams.shutdown(), unrelated.teams.shutdown()]);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

it('revokes an in-flight native plan before its queued continuation can create a child after shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-shutdown-queued-plan-'));
  const context = new BoundControlContext('TEST-app', root);
  const run = { ...context.snapshot(), teamName: 'test-plan', runId: 'TEST-run' };
  let finishPlan!: (plan: NodeMemberLaunchPlan) => void;
  const plan = new Promise<NodeMemberLaunchPlan>((resolve) => {
    finishPlan = resolve;
  });
  const preparing = vi.fn(() => plan);
  const spawned = vi.fn(() => Promise.resolve());
  const disposed = vi.fn(() => Promise.resolve());
  const prepared: NodeMemberLaunchPlan = {
    executable: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: root,
    env: process.env,
    afterSpawn: spawned,
    dispose: disposed,
  };
  const lifecycle = createMemberLifecycle({
    owner: context.snapshot(),
    settings: {
      findConfiguredMember: (team, memberName) =>
        Promise.resolve({
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          providerId: 'TEST',
          model: null,
          workingDirectory: root,
          instructions: 'TEST',
        }),
    },
    runtime: new NodeMemberRuntime({ prepare: preparing }, async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    }),
  });
  try {
    await lifecycle.teams.launch(run, [{ memberName: 'team-lead', role: 'lead' }]);
    await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce());
    finishPlan(prepared);
    await lifecycle.teams.shutdown();
    expect(spawned).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledOnce();
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
  } finally {
    finishPlan(prepared);
    await lifecycle.teams.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
