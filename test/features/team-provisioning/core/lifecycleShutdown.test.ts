import { describe, expect, it, vi } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { TeamRunIdentity } from '../../../../src/features/team-provisioning/contracts';
import type { MemberRuntimeEvents } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const first = { ...owner, teamName: 'test-first', runId: 'TEST-first' };
const second = { ...owner, teamName: 'test-second', runId: 'TEST-second' };
const roster = [
  { memberName: 'team-lead', role: 'lead' as const },
  { memberName: 'builder', role: 'member' as const },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// РИСК: controlled owned handles and resource ports prove shutdown ordering, not OS subtree/crash containment.
function setup(
  options: {
    prepare?(run: TeamRunIdentity): Promise<void>;
    release?(run: TeamRunIdentity): Promise<void>;
    stop?(run: TeamRunIdentity, member: string, events: MemberRuntimeEvents): Promise<void>;
    beforeSpawn?(run: TeamRunIdentity, member: string): Promise<void>;
  } = {}
) {
  const starts: string[] = [];
  const stops: string[] = [];
  const events = new Map<string, MemberRuntimeEvents>();
  const settings = vi.fn((team: TeamRunIdentity, memberName: string) =>
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
      providerId: 'TEST',
      model: null,
      workingDirectory: 'TEST',
      instructions: 'TEST',
    })
  );
  const lifecycle = createMemberLifecycle({
    owner,
    settings: { findConfiguredMember: settings },
    teamResources: {
      prepare: (run) => options.prepare?.(run) ?? Promise.resolve(),
      release: (run) => options.release?.(run) ?? Promise.resolve(),
    },
    runtime: {
      async spawn(launch) {
        await options.beforeSpawn?.(launch.team, launch.memberName);
        const id = `${launch.team.teamName}/${launch.memberName}`;
        starts.push(id);
        let listener!: MemberRuntimeEvents;
        return Promise.resolve({
          identity: { pid: 100 + starts.length, birthId: id },
          writeInput: () => Promise.resolve(),
          subscribe(value: MemberRuntimeEvents) {
            listener = value;
            events.set(id, value);
            value.connected();
            return () => {
              events.delete(id);
            };
          },
          stop: async () => {
            stops.push(id);
            if (options.stop) await options.stop(launch.team, launch.memberName, listener);
            else {
              listener.exited({ code: 0, signal: null });
              listener.released();
            }
          },
        });
      },
    },
  });
  const launch = async (run: TeamRunIdentity) => {
    const receipt = await lifecycle.teams.launch(run, roster);
    await Promise.all(roster.map(({ memberName }) => lifecycle.commands.settled(run, memberName)));
    return receipt;
  };
  return { lifecycle, launch, starts, stops, events, settings };
}

describe('single-owner application lifecycle shutdown', () => {
  it('revokes all owned runs immediately and permanently closes starts without hiding stopped snapshots', async () => {
    const { lifecycle, launch, starts, stops } = setup();
    const a = await launch(first);
    const b = await launch(second);
    const closing = lifecycle.teams.shutdown();
    expect(lifecycle.snapshot(first.teamName).desired).toBe('stopped');
    expect(lifecycle.snapshot(second.teamName).desired).toBe('stopped');
    await expect(
      lifecycle.leadStart.execute(a.leadCredential, { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
    await expect(
      lifecycle.leadStart.execute(b.leadCredential, { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
    await expect(lifecycle.commands.start(first, 'builder')).rejects.toThrow('closed');
    await closing;
    expect(stops).toHaveLength(4);
    expect(starts).toHaveLength(4);
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    expect(lifecycle.snapshot(second.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    const saved = lifecycle.snapshot(first.teamName);
    await lifecycle.teams.shutdown();
    expect(lifecycle.snapshot(first.teamName)).toEqual(saved);
    await expect(lifecycle.teams.launch({ ...first, runId: 'TEST-new' }, roster)).rejects.toThrow(
      'closed'
    );
    const load = vi.fn(() => Promise.resolve(roster));
    await expect(lifecycle.teams.launchCurrent(owner, 'test-new', load)).rejects.toThrow('closed');
    expect(load).not.toHaveBeenCalled();
  });

  it('closes an empty owner before a queued launch can load settings or spawn', async () => {
    const { lifecycle, starts } = setup();
    const load = vi.fn(() => Promise.resolve(roster));
    const launching = lifecycle.teams.launchCurrent(owner, first.teamName, load);
    const rejected = expect(launching).rejects.toThrow('closed');
    await lifecycle.teams.shutdown();
    await rejected;
    expect(load).not.toHaveBeenCalled();
    expect(starts).toEqual([]);
  });

  it('cancels a pending read-only roster load without inventing a process or waiting for an unresponsive reader', async () => {
    const { lifecycle, starts } = setup();
    const reading = deferred<typeof roster>();
    const load = vi.fn(() => reading.promise);
    const launching = lifecycle.teams.launchCurrent(owner, first.teamName, load);
    const rejected = expect(launching).rejects.toThrow();
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const run = lifecycle.snapshot(first.teamName).identity;
    await lifecycle.teams.shutdown();
    await rejected;
    reading.resolve(roster);
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      identity: run,
      desired: 'stopped',
      resources: 'released',
    });
  });

  it('physically drains mutating preparation and cleanup before completing shutdown', async () => {
    const preparing = deferred<void>();
    const releasing = deferred<void>();
    const prepare = vi.fn(() => preparing.promise);
    const release = vi.fn(() => releasing.promise);
    const { lifecycle, starts } = setup({ prepare, release });
    const launching = lifecycle.teams.launch(first, roster);
    const rejected = expect(launching).rejects.toThrow();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    let complete = false;
    const closing = lifecycle.teams.shutdown().then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(release).not.toHaveBeenCalled();
    preparing.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    releasing.resolve();
    await closing;
    await rejected;
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(first.teamName).resources).toBe('released');
  });

  it('shares concurrent shutdown and still drains exact handles after their exit observations arrive', async () => {
    const terminated = deferred<void>();
    const { lifecycle, launch, stops } = setup({
      stop: async (_run, _member, events) => {
        events.exited({ code: 0, signal: null });
        events.released();
        await terminated.promise;
      },
    });
    await launch(first);
    const a = lifecycle.teams.shutdown();
    const b = lifecycle.teams.shutdown();
    let complete = false;
    const completed = Promise.all([a, b]).then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(stops).toHaveLength(2));
    expect(complete).toBe(false);
    terminated.resolve();
    await completed;
    expect(stops).toHaveLength(2);
    expect(lifecycle.snapshot(first.teamName).resources).toBe('released');
  });

  it('waits for an earlier member stop whose release event arrived before its termination operation settled', async () => {
    const terminated = deferred<void>();
    const { lifecycle, launch, stops } = setup({
      stop: async (_run, member, events) => {
        events.exited({ code: 0, signal: null });
        events.released();
        if (member === 'builder') await terminated.promise;
      },
    });
    await launch(first);
    const stopping = lifecycle.commands.stop(first, 'builder');
    await vi.waitFor(() => expect(stops).toContain(`${first.teamName}/builder`));
    expect(lifecycle.snapshot(first.teamName).members.builder.resources).toBe('released');
    expect(await lifecycle.commands.start(first, 'builder')).toEqual({ kind: 'stopping' });
    expect(lifecycle.commands.hasUnreleased(first)).toBe(true);
    let complete = false;
    const closing = lifecycle.teams.shutdown().then(() => {
      complete = true;
    });
    await vi.waitFor(() => expect(stops).toHaveLength(2));
    expect(complete).toBe(false);
    expect(lifecycle.snapshot(first.teamName).resources).toBe('releasing');
    terminated.resolve();
    await Promise.all([stopping, closing]);
    expect(lifecycle.snapshot(first.teamName).resources).toBe('released');
  });

  it('stops every owned team even when one release fails, retains the failure and permits only an exact cleanup retry', async () => {
    let fail = true;
    const release = vi.fn((run: TeamRunIdentity) =>
      run.teamName === first.teamName && fail
        ? Promise.reject(new Error('TEST release failed'))
        : Promise.resolve()
    );
    const { lifecycle, launch, starts, stops } = setup({ release });
    await launch(first);
    await launch(second);
    await expect(lifecycle.teams.shutdown()).rejects.toThrow('shutdown');
    expect(stops).toHaveLength(4);
    expect(lifecycle.snapshot(second.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      state: 'release-failed',
      resources: 'release-failed',
      error: 'TEST release failed',
    });
    await expect(lifecycle.commands.start(first, 'builder')).rejects.toThrow('closed');
    fail = false;
    await lifecycle.teams.shutdown();
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      resources: 'released',
      state: 'stopped',
    });
    expect(starts).toHaveLength(4);
    expect(stops).toHaveLength(4);
    expect(release.mock.calls.filter(([run]) => run.teamName === first.teamName)).toHaveLength(2);
  });

  it('does not start a runtime from a settings result already queued when shutdown closes admission', async () => {
    const { lifecycle, starts, settings } = setup();
    const reading = deferred<Awaited<ReturnType<typeof settings>>>();
    const configured = await settings(first, 'team-lead');
    settings.mockImplementation(() => reading.promise);
    await lifecycle.teams.launch(first, [{ memberName: 'team-lead', role: 'lead' }]);
    await vi.waitFor(() => expect(settings).toHaveBeenCalledTimes(2));
    reading.resolve(configured);
    const closing = lifecycle.teams.shutdown();
    await closing;
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
  });

  it('drains a process returned late by an already-started spawn instead of releasing its run early', async () => {
    const spawned = deferred<void>();
    const beforeSpawn = vi.fn((_run: TeamRunIdentity, member: string) =>
      member === 'builder' ? spawned.promise : Promise.resolve()
    );
    const { lifecycle, starts, stops } = setup({ beforeSpawn });
    await lifecycle.teams.launch(first, roster);
    await vi.waitFor(() => expect(beforeSpawn).toHaveBeenCalledTimes(2));
    let complete = false;
    const closing = lifecycle.teams.shutdown().then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    spawned.resolve();
    await closing;
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      desired: 'stopped',
      state: 'stopped',
      resources: 'released',
    });
    expect(
      Object.values(lifecycle.snapshot(first.teamName).members).every(
        (member) => member.process === null && member.resources === 'released'
      )
    ).toBe(true);
  });

  it('cancels an already-pending member restart so its late stop cannot admit a replacement', async () => {
    const terminated = deferred<void>();
    const { lifecycle, launch, starts, stops } = setup({
      stop: async (_run, member, events) => {
        if (member === 'builder') await terminated.promise;
        events.exited({ code: 0, signal: null });
        events.released();
      },
    });
    await launch(first);
    const restarting = lifecycle.commands.restart({
      ...first,
      memberName: 'builder',
      generation: 1,
    });
    const rejected = expect(restarting).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(stops).toContain(`${first.teamName}/builder`));
    const closing = lifecycle.teams.shutdown();
    terminated.resolve();
    await closing;
    await rejected;
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(first.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
  });
});
