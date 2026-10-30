// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type {
  MemberRuntimeEvents,
  MemberRuntimePort,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// РИСК: controlled handles prove ownership and ordering, not OS termination or provider acceptance.
async function setup(beforeSpawn?: (memberName: string, signal: AbortSignal) => Promise<void>) {
  const events: MemberRuntimeEvents[] = [];
  const starts: string[] = [];
  const stops: number[] = [];
  let terminate: (events: MemberRuntimeEvents) => Promise<void> = (listener) => {
    listener.exited({ code: 0, signal: null });
    listener.released();
    return Promise.resolve();
  };
  const runtime: MemberRuntimePort = {
    async spawn(settings, _token, signal) {
      const index = starts.length;
      starts.push(settings.memberName);
      await beforeSpawn?.(settings.memberName, signal);
      return {
        identity: { pid: 100 + index, birthId: `TEST-birth-${index}` },
        writeInput: () => Promise.resolve(),
        subscribe(listener) {
          events[index] = listener;
          listener.connected();
          return () => undefined;
        },
        stop() {
          stops.push(index);
          return terminate(events[index]);
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
          providerId: 'anthropic',
          model: 'TEST-model',
          workingDirectory: 'TEST-workspace',
          instructions: 'TEST',
        }),
    },
  });
  const receipt = await lifecycle.teams.launch(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
  ]);
  await Promise.all(['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name)));
  return {
    lifecycle,
    receipt,
    events,
    starts,
    stops,
    target: { ...run, memberName: 'builder', generation: 1 },
    setTerminate: (operation: typeof terminate) => {
      terminate = operation;
    },
  };
}

describe('exact observed member restart', () => {
  it('coalesces concurrent restarts, waits for release and leaves the lead unchanged', async () => {
    const { lifecycle, target, starts, stops, setTerminate } = await setup();
    const released = deferred();
    setTerminate(async (events) => {
      events.exited({ code: 0, signal: null });
      await released.promise;
      events.released();
    });
    const lead = lifecycle.snapshot(run.teamName).members['team-lead'];
    const first = lifecycle.commands.restart(target);
    const second = lifecycle.commands.restart(target);
    await expect.poll(() => stops.length).toBe(1);
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      process: null,
      resources: 'releasing',
      desired: 'stopped',
      generation: 1,
    });
    expect(await lifecycle.commands.start(run, 'builder')).toEqual({ kind: 'stopping' });
    expect(starts).toEqual(['team-lead', 'builder']);
    released.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'launch', token: { generation: 2, memberName: 'builder' } });
    await lifecycle.commands.settled(run, 'builder');
    expect(starts).toEqual(['team-lead', 'builder', 'builder']);
    expect(lifecycle.snapshot(run.teamName).members['team-lead']).toEqual(lead);
  });

  it('rejects a delayed old generation before stopping its successor', async () => {
    const { lifecycle, target, stops, starts, events } = await setup();
    const old = events[1];
    await lifecycle.commands.restart(target);
    await lifecycle.commands.settled(run, 'builder');
    const current = lifecycle.snapshot(run.teamName);
    await expect(lifecycle.commands.restart(target)).rejects.toThrow('generation');
    expect(stops).toEqual([1]);
    expect(starts).toHaveLength(3);
    old.connected();
    old.failed('TEST old failure');
    old.exited({ code: 1, signal: null });
    old.released();
    expect(lifecycle.snapshot(run.teamName)).toEqual(current);
  });

  it('retains a failed termination and allows an exact retry without overlapping processes', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    setTerminate(() => Promise.reject(new Error('TEST process still alive')));
    await expect(lifecycle.commands.restart(target)).rejects.toThrow('termination');
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      generation: 1,
      resources: 'held',
      phase: 'stopping',
      process: { pid: 101, birthId: 'TEST-birth-1' },
    });
    expect(starts).toHaveLength(2);
    setTerminate((events) => {
      events.exited({ code: 0, signal: null });
      events.released();
      return Promise.resolve();
    });
    await lifecycle.commands.restart(target);
    await lifecycle.commands.settled(run, 'builder');
    expect(starts).toHaveLength(3);
    expect(stops).toEqual([1, 1]);
  });

  it('does not accept termination success without the exact resource-release observation', async () => {
    const { lifecycle, target, setTerminate, starts } = await setup();
    setTerminate((events) => {
      events.exited({ code: 0, signal: null });
      return Promise.resolve();
    });
    await expect(lifecycle.commands.restart(target)).rejects.toThrow('released');
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName).members.builder.resources).toBe('releasing');
  });

  it('lets an explicit member stop cancel a pending restart without resurrection', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    const release = deferred();
    setTerminate(async (events) => {
      await release.promise;
      events.exited({ code: 0, signal: null });
      events.released();
    });
    const restarted = lifecycle.commands.restart(target);
    const rejected = expect(restarted).rejects.toThrow('cancelled');
    await expect.poll(() => stops.length).toBe(1);
    const stopped = lifecycle.commands.stop(run, 'builder');
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members.builder.desired)
      .toBe('stopped');
    release.resolve();
    await Promise.all([stopped, rejected]);
    expect(stops).toEqual([1]);
    expect(starts).toHaveLength(2);
    expect(lifecycle.registry.recoveryCandidates(run.teamName)).toEqual([]);
  });

  it('lets intentional team stop cancel a pending restart and revoke lead authority', async () => {
    const { lifecycle, target, setTerminate, starts, stops, receipt } = await setup();
    const release = deferred();
    setTerminate(async (events) => {
      await release.promise;
      events.exited({ code: 0, signal: null });
      events.released();
    });
    const restarted = lifecycle.commands.restart(target);
    const rejected = expect(restarted).rejects.toThrow('cancelled');
    await expect.poll(() => stops.length).toBe(1);
    const stopped = lifecycle.teams.stop(run);
    await expect.poll(() => lifecycle.snapshot(run.teamName).desired).toBe('stopped');
    release.resolve();
    await Promise.all([stopped, rejected]);
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName).state).toBe('stopped');
    await expect(
      lifecycle.leadStart.execute(receipt.leadCredential, { memberName: 'builder' })
    ).rejects.toThrow();
  });

  it('does not restart a member removed while its old process drains', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    const release = deferred();
    setTerminate(async (events) => {
      await release.promise;
      events.exited({ code: 0, signal: null });
      events.released();
    });
    const restarted = lifecycle.commands.restart(target);
    const rejected = expect(restarted).rejects.toThrow('removed');
    await expect.poll(() => stops.length).toBe(1);
    lifecycle.registry.removeMember(run, 'builder');
    release.resolve();
    await rejected;
    expect(starts).toHaveLength(2);
  });

  it.each([
    { memberName: 'team-lead', generation: 1 },
    { memberName: 'invented', generation: 1 },
    { memberName: 'builder', generation: 0 },
    { memberName: 'builder', generation: 1, runId: 'TEST-old-run' },
    { memberName: 'builder', generation: 1, appInstanceId: 'TEST-other-app' },
  ])('rejects an unauthorized or stale observed target before any stop: %j', async (fields) => {
    const { lifecycle, starts, stops } = await setup();
    const before = lifecycle.snapshot(run.teamName);
    await expect(lifecycle.commands.restart({ ...run, ...fields })).rejects.toThrow();
    expect(stops).toEqual([]);
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
  });

  it('does not let member_start preempt a restart after release but before termination settles', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    const termination = deferred();
    setTerminate(async (events) => {
      events.exited({ code: 0, signal: null });
      events.released();
      await termination.promise;
    });
    const restarted = lifecycle.commands.restart(target);
    await expect.poll(() => stops.length).toBe(1);
    expect(await lifecycle.commands.start(run, 'builder')).toEqual({ kind: 'stopping' });
    const beforeSkip = lifecycle.snapshot(run.teamName);
    await expect(lifecycle.commands.skip(target)).rejects.toThrow('restart is still settling');
    expect(lifecycle.snapshot(run.teamName)).toEqual(beforeSkip);
    expect(starts).toHaveLength(2);
    termination.resolve();
    await expect(restarted).resolves.toMatchObject({ kind: 'launch', token: { generation: 2 } });
    await lifecycle.commands.settled(run, 'builder');
    expect(starts).toHaveLength(3);
  });

  it('drains a cancelled restart before intentional team release even after release events arrive', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    const termination = deferred();
    let first = true;
    setTerminate(async (events) => {
      events.exited({ code: 0, signal: null });
      events.released();
      if (first) {
        first = false;
        await termination.promise;
      }
    });
    const restarted = lifecycle.commands.restart(target);
    const rejected = expect(restarted).rejects.toThrow('cancelled');
    await expect.poll(() => stops.length).toBe(1);
    let stopped = false;
    const stopping = lifecycle.teams.stop(run).then(() => {
      stopped = true;
    });
    await expect.poll(() => stops.length).toBe(2);
    expect(stopped).toBe(false);
    expect(lifecycle.snapshot(run.teamName).resources).toBe('releasing');
    termination.resolve();
    await Promise.all([stopping, rejected]);
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName).state).toBe('stopped');
  });

  it('cancels replacement on context invalidation but physically waits for exact termination', async () => {
    const { lifecycle, target, setTerminate, starts, stops } = await setup();
    const termination = deferred();
    setTerminate(async (events) => {
      await termination.promise;
      events.exited({ code: 0, signal: null });
      events.released();
    });
    const abort = new AbortController();
    let settled = false;
    const restarted = lifecycle.commands.restart(target, abort.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(restarted).rejects.toThrow('cancelled');
    await expect.poll(() => stops.length).toBe(1);
    abort.abort();
    expect(settled).toBe(false);
    expect(starts).toHaveLength(2);
    termination.resolve();
    await rejected;
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(run.teamName).members.builder).toMatchObject({
      desired: 'stopped',
      process: null,
      resources: 'released',
    });
  });

  it('restarts an exited and released generation without trying to terminate it again', async () => {
    const { lifecycle, target, starts, stops, events } = await setup();
    const first = events[1];
    first.exited({ code: 0, signal: null });
    first.released();
    const restarting = lifecycle.commands.restart(target);
    await expect(restarting).resolves.toMatchObject({ kind: 'launch', token: { generation: 2 } });
    await lifecycle.commands.settled(run, 'builder');
    expect(starts).toHaveLength(3);
    expect(stops).toEqual([]);
  });

  it('cancels an in-flight spawn and drains its late exact handle before replacement', async () => {
    let block: ((signal: AbortSignal) => Promise<void>) | undefined;
    const { lifecycle, starts, stops } = await setup((member, signal) =>
      member === 'builder' && block ? block(signal) : Promise.resolve()
    );
    await lifecycle.commands.stop(run, 'builder');
    const entered = deferred();
    const spawned = deferred();
    let aborted: AbortSignal | undefined;
    block = (signal) => {
      aborted = signal;
      entered.resolve();
      return spawned.promise;
    };
    await lifecycle.commands.start(run, 'builder');
    await entered.promise;
    const restarted = lifecycle.commands.restart({ ...run, memberName: 'builder', generation: 2 });
    await expect.poll(() => aborted?.aborted).toBe(true);
    expect(starts).toHaveLength(3);
    expect(stops).toEqual([1]);
    block = undefined;
    spawned.resolve();
    await expect(restarted).resolves.toMatchObject({ kind: 'launch', token: { generation: 3 } });
    await lifecycle.commands.settled(run, 'builder');
    expect(stops).toEqual([1, 2]);
    expect(starts).toEqual(['team-lead', 'builder', 'builder', 'builder']);
  });

  it('captures the caller target before queued work can mutate it', async () => {
    const { lifecycle, target, starts, stops } = await setup();
    const pending = lifecycle.commands.restart(target);
    Object.assign(target, { memberName: 'team-lead', generation: 99, runId: 'TEST-foreign' });
    await pending;
    await lifecycle.commands.settled(run, 'builder');
    expect(stops).toEqual([1]);
    expect(starts).toEqual(['team-lead', 'builder', 'builder']);
  });
});
