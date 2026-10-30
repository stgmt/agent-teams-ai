// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { MemberRuntimeEvents } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };

// РИСК: controlled startup failures prove lifecycle admission, not native provider or OS termination.
async function setup() {
  const events = new Map<string, MemberRuntimeEvents>();
  const starts: string[] = [];
  const stops: string[] = [];
  const lifecycle = createMemberLifecycle({
    owner,
    settings: {
      findConfiguredMember: (team, memberName) =>
        Promise.resolve({
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          providerId: 'anthropic',
          model: null,
          workingDirectory: 'TEST-workspace',
          instructions: 'TEST',
        }),
    },
    runtime: {
      spawn(settings) {
        starts.push(settings.memberName);
        if (settings.memberName === 'builder' && starts.length === 2)
          return Promise.reject(new Error('TEST startup failed'));
        return Promise.resolve({
          identity: { pid: 100 + starts.length, birthId: `TEST-${starts.length}` },
          writeInput: () => Promise.resolve(),
          subscribe(listener: MemberRuntimeEvents) {
            events.set(settings.memberName, listener);
            listener.connected();
            return () => undefined;
          },
          stop() {
            stops.push(settings.memberName);
            const listener = events.get(settings.memberName)!;
            listener.exited({ code: 0, signal: null });
            listener.released();
            return Promise.resolve();
          },
        });
      },
    },
  });
  const members = [
    { memberName: 'team-lead', role: 'lead' as const },
    { memberName: 'builder', role: 'member' as const },
  ];
  await lifecycle.teams.launch(run, members);
  await Promise.all(members.map(({ memberName }) => lifecycle.commands.settled(run, memberName)));
  const target = { ...run, memberName: 'builder', generation: 1 };
  return { lifecycle, target, starts, stops, members };
}

describe('skip only the observed failed startup for this launch', () => {
  it('keeps the configured member and failure evidence, excludes recovery and derives ready from the remaining members', async () => {
    const { lifecycle, target, starts, stops } = await setup();
    expect(lifecycle.snapshot(run.teamName).state).toBe('degraded');
    await lifecycle.commands.skip(target);
    const skipped = lifecycle.snapshot(run.teamName);
    expect(skipped.state).toBe('ready');
    expect(skipped.members.builder).toMatchObject({
      membership: 'configured',
      desired: 'stopped',
      phase: 'stopped',
      resources: 'released',
      generation: 1,
      skippedForLaunch: true,
      error: 'TEST startup failed',
      process: null,
    });
    expect(lifecycle.registry.recoveryCandidates(run.teamName)).toEqual([]);
    await lifecycle.commands.skip(target);
    expect(lifecycle.snapshot(run.teamName)).toEqual(skipped);
    expect(starts).toEqual(['team-lead', 'builder']);
    expect(stops).toEqual([]);
  });

  it('allows an explicit configured start after skip and rejects delayed skip of the old generation', async () => {
    const { lifecycle, target, starts, stops } = await setup();
    await lifecycle.commands.skip(target);
    const admitted = await lifecycle.commands.start(run, 'builder');
    expect(admitted).toMatchObject({ kind: 'launch', token: { generation: 2 } });
    await lifecycle.commands.settled(run, 'builder');
    const current = lifecycle.snapshot(run.teamName);
    expect(current.members.builder).toMatchObject({ skippedForLaunch: false, phase: 'ready' });
    await expect(lifecycle.commands.skip(target)).rejects.toThrow('generation');
    expect(lifecycle.snapshot(run.teamName)).toEqual(current);
    expect(starts).toHaveLength(3);
    expect(stops).toEqual([]);
  });

  it('does not retain a per-launch skip in a successor run', async () => {
    const { lifecycle, target, members } = await setup();
    await lifecycle.commands.skip(target);
    await lifecycle.teams.stop(run);
    const successor = { ...run, runId: 'TEST-successor' };
    await lifecycle.teams.launch(successor, members);
    await Promise.all(
      members.map(({ memberName }) => lifecycle.commands.settled(successor, memberName))
    );
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      skippedForLaunch: false,
      desired: 'running',
      phase: 'ready',
    });
    await expect(lifecycle.commands.skip(target)).rejects.toThrow('identity');
  });

  it.each([
    { appInstanceId: 'TEST-foreign' },
    { dataRootFingerprint: 'TEST-foreign' },
    { connectionGeneration: 2 },
    { runId: 'TEST-old' },
    { memberName: 'invented' },
    { memberName: 'team-lead' },
    { generation: 0 },
    { generation: -1 },
    { generation: Number.NaN },
    { generation: 1.5 },
  ])('rejects a foreign, stale or invalid selection without mutation: %j', async (fields) => {
    const { lifecycle, target, starts, stops } = await setup();
    const before = lifecycle.snapshot(run.teamName);
    await expect(lifecycle.commands.skip({ ...target, ...fields })).rejects.toThrow();
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
    expect(starts).toHaveLength(2);
    expect(stops).toEqual([]);
  });

  it.each([
    'removed',
    'team-stopped',
    'cleanup-held',
    'process-held',
    'previously-connected',
  ] as const)('does not hide an ineligible member: %s', async (state) => {
    const { lifecycle, target } = await setup();
    if (state === 'removed') lifecycle.registry.removeMember(run, 'builder');
    if (state === 'team-stopped') await lifecycle.teams.stop(run);
    if (['cleanup-held', 'process-held', 'previously-connected'].includes(state)) {
      const admission = lifecycle.registry.beginStart(run, 'builder', 'TEST-next');
      if (admission.kind !== 'launch') throw new Error('TEST launch not admitted');
      target.generation = admission.token.generation;
      if (state === 'cleanup-held')
        lifecycle.registry.observeStartFailed(admission.token, 'TEST failed');
      else {
        const process = { pid: 999, birthId: 'TEST-held' };
        lifecycle.registry.observeSpawn(admission.token, process);
        if (state === 'previously-connected') lifecycle.registry.observeConnected(admission.token);
        lifecycle.registry.observeRuntimeFailed(admission.token, 'TEST failed');
        if (state === 'previously-connected') {
          lifecycle.registry.observeExit(admission.token, process, { code: 1, signal: null });
          lifecycle.registry.observeMemberReleased(admission.token);
        }
      }
    }
    const before = lifecycle.snapshot(run.teamName);
    await expect(lifecycle.commands.skip(target)).rejects.toThrow();
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
  });

  it('preserves the skipped failure evidence against late observations from the released attempt', async () => {
    const { lifecycle, target } = await setup();
    const token = {
      ...target,
      operationId: lifecycle.snapshot(run.teamName).members.builder.operationId!,
    };
    await lifecycle.commands.skip(target);
    const before = lifecycle.snapshot(run.teamName);
    expect(lifecycle.registry.observeRuntimeFailed(token, 'TEST late failure')).toBe(false);
    expect(lifecycle.registry.observeMemberReleaseFailed(token)).toBe(false);
    expect(lifecycle.registry.observeMemberReleased(token)).toBe(false);
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
  });

  it('does not mutate a failed member after caller cancellation while waiting for admission', async () => {
    const { lifecycle, target } = await setup();
    const before = lifecycle.snapshot(run.teamName);
    const abort = new AbortController();
    const pending = lifecycle.commands.skip(target, abort.signal);
    abort.abort(new Error('TEST context invalidated'));
    await expect(pending).rejects.toThrow('context invalidated');
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
  });

  it('captures the exact caller target before queued work can mutate it', async () => {
    const { lifecycle, target } = await setup();
    const pending = lifecycle.commands.skip(target);
    Object.assign(target, { memberName: 'team-lead', generation: 99, runId: 'TEST-other' });
    await pending;
    expect(lifecycle.snapshot(run.teamName).members.builder.skippedForLaunch).toBe(true);
    expect(lifecycle.snapshot(run.teamName).members['team-lead'].skippedForLaunch).toBe(false);
  });

  it('distinguishes a failed new attempt from successful connection history in this run', async () => {
    const { lifecycle, target } = await setup();
    await lifecycle.commands.start(run, 'builder');
    await lifecycle.commands.settled(run, 'builder');
    await lifecycle.commands.stop(run, 'builder');
    const next = lifecycle.registry.beginStart(run, 'builder', 'TEST-failed-retry');
    if (next.kind !== 'launch') throw new Error('TEST launch not admitted');
    lifecycle.registry.observeStartFailed(next.token, 'TEST retry failed');
    lifecycle.registry.observeMemberReleased(next.token);
    await lifecycle.commands.skip(next.token);
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      everConnected: true,
      skippedForLaunch: true,
      error: 'TEST retry failed',
    });
    await expect(lifecycle.commands.skip(target)).rejects.toThrow('generation');
  });

  it('accepts a released early process exit but not a configured member that never attempted startup', async () => {
    const { lifecycle } = await setup();
    const admission = lifecycle.registry.beginStart(run, 'builder', 'TEST-early-exit');
    if (admission.kind !== 'launch') throw new Error('TEST launch not admitted');
    const process = { pid: 999, birthId: 'TEST-early' };
    lifecycle.registry.observeSpawn(admission.token, process);
    lifecycle.registry.observeExit(admission.token, process, { code: 1, signal: null });
    lifecycle.registry.observeMemberReleased(admission.token);
    await lifecycle.commands.skip(admission.token);
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      skippedForLaunch: true,
      exit: { code: 1, signal: null },
    });
    await lifecycle.teams.stop(run);
    const next = { ...run, runId: 'TEST-unstarted' };
    lifecycle.registry.configureTeam(next, [{ memberName: 'builder', role: 'member' }]);
    await expect(
      lifecycle.commands.skip({ ...next, memberName: 'builder', generation: 0 })
    ).rejects.toThrow('startup');
  });
});
