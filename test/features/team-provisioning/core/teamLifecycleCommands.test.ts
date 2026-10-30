import { describe, expect, it } from 'vitest';

import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';
import type {
  ConfiguredMemberLaunch,
  MemberRuntimeEvents,
  MemberRuntimePort,
  OwnedMemberProcess,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };
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

function setup(
  findSettings?: (team: typeof run, memberName: string) => Promise<ConfiguredMemberLaunch | null>
) {
  const starts: string[] = [];
  const stops: string[] = [];
  const events = new Map<string, MemberRuntimeEvents>();
  const runtime: MemberRuntimePort = {
    async spawn(settings) {
      starts.push(settings.memberName);
      return {
        identity: { pid: starts.length + 100, birthId: settings.memberName },
        async writeInput() {},
        subscribe(listener) {
          events.set(settings.memberName, listener);
          listener.connected();
          return () => events.delete(settings.memberName);
        },
        async stop() {
          stops.push(settings.memberName);
          events.get(settings.memberName)?.exited({ code: 0, signal: null });
          events.get(settings.memberName)?.released();
        },
      };
    },
  };
  const lifecycle = createMemberLifecycle({
    owner,
    settings: {
      findConfiguredMember:
        findSettings ??
        (async (team, memberName) => ({
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          providerId: 'TEST',
          model: null,
          workingDirectory: 'TEST',
          instructions: 'TEST',
        })),
    },
    runtime,
  });
  return { lifecycle, starts, stops, events };
}

async function settle(lifecycle: ReturnType<typeof createMemberLifecycle>) {
  await Promise.all(roster.map((member) => lifecycle.commands.settled(run, member.memberName)));
}

describe('authoritative team run commands', () => {
  it('assigns one application-owned run to concurrent team-name launches before reading settings', async () => {
    const pending = deferred<typeof roster>();
    const { lifecycle, starts } = setup();
    const reads: (typeof run)[] = [];
    const load = async (identity: typeof run) => {
      reads.push(identity);
      return pending.promise;
    };
    const first = lifecycle.teams.launchCurrent(owner, run.teamName, load);
    const second = lifecycle.teams.launchCurrent(owner, run.teamName, load);
    await expect.poll(() => reads.length).toBe(1);
    const preparing = lifecycle.snapshot(run.teamName);
    expect(preparing.identity).toMatchObject({ ...owner, teamName: run.teamName });
    expect(preparing.identity.runId).toBeTruthy();
    expect(preparing.state).toBe('preparing');
    expect(reads[0]).toEqual(preparing.identity);
    pending.resolve(roster);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toEqual(right);
    expect(left.run).toEqual(preparing.identity);
    await Promise.all(
      roster.map(({ memberName }) => lifecycle.commands.settled(left.run, memberName))
    );
    expect(starts.toSorted((a, b) => a.localeCompare(b))).toEqual(['builder', 'team-lead']);
    await lifecycle.teams.stop(left.run);
  });

  it('returns an admitted run without re-reading settings or recovering a failed member', async () => {
    const { lifecycle, starts, events } = setup();
    const first = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    await Promise.all(
      roster.map(({ memberName }) => lifecycle.commands.settled(first.run, memberName))
    );
    events.get('builder')!.exited({ code: 1, signal: null });
    events.get('builder')!.released();
    const before = lifecycle.snapshot(run.teamName);
    let reads = 0;
    const again = await lifecycle.teams.launchCurrent(owner, run.teamName, () => {
      reads++;
      return Promise.resolve(roster);
    });
    expect(again).toEqual(first);
    expect(reads).toBe(0);
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
    expect(starts).toEqual(['team-lead', 'builder']);
    await lifecycle.teams.stop(first.run);
  });

  it('assigns a new run only after intentional stop has released the previous run', async () => {
    const { lifecycle } = setup();
    const first = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    await lifecycle.teams.stop(first.run);
    const next = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    expect(next.run.runId).not.toBe(first.run.runId);
    expect(next.leadCredential).not.toBe(first.leadCredential);
    await expect(lifecycle.teams.stop(first.run)).rejects.toThrow('stale');
    expect(lifecycle.snapshot(run.teamName).identity).toEqual(next.run);
    await lifecycle.teams.stop(next.run);
  });

  it('retries a failed canonical read with a new run rather than reusing its failed identity', async () => {
    const { lifecycle, starts } = setup();
    await expect(
      lifecycle.teams.launchCurrent(owner, run.teamName, () =>
        Promise.reject(new Error('TEST configured roster unavailable'))
      )
    ).rejects.toThrow('roster unavailable');
    const failed = lifecycle.snapshot(run.teamName);
    expect(failed).toMatchObject({
      resources: 'released',
      error: 'TEST configured roster unavailable',
    });
    expect(starts).toEqual([]);
    const next = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    expect(next.run.runId).not.toBe(failed.identity.runId);
    await lifecycle.teams.stop(next.run);
  });

  it('does not reuse an earlier admission when a successor fails before admitting its roster', async () => {
    const { lifecycle } = setup();
    const first = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    await lifecycle.teams.stop(first.run);
    await expect(
      lifecycle.teams.launchCurrent(owner, run.teamName, () =>
        Promise.reject(new Error('TEST successor metadata unavailable'))
      )
    ).rejects.toThrow('successor metadata');
    const failed = lifecycle.snapshot(run.teamName);
    expect(failed.identity.runId).not.toBe(first.run.runId);
    const next = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    expect(next.run.runId).not.toBe(failed.identity.runId);
    await lifecycle.teams.stop(next.run);
  });

  it('cancels the selected preparing run and never spawns from its late settings', async () => {
    const pending = deferred<typeof roster>();
    const { lifecycle, starts } = setup();
    const first = lifecycle.teams.launchCurrent(owner, run.teamName, async () => pending.promise);
    const rejected = expect(first).rejects.toThrow();
    await expect.poll(() => lifecycle.registry.findSnapshot(run.teamName)?.state).toBe('preparing');
    const selected = lifecycle.snapshot(run.teamName).identity;
    await lifecycle.teams.stop(selected);
    await rejected;
    pending.resolve(roster);
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      identity: selected,
      state: 'stopped',
    });
    const next = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    expect(next.run.runId).not.toBe(selected.runId);
    await lifecycle.teams.stop(next.run);
  });

  it('cancels a context-bound pending read when its admission signal is revoked', async () => {
    const { lifecycle, starts } = setup();
    const abort = new AbortController();
    const blocked = deferred<typeof roster>();
    const launching = lifecycle.teams.launchCurrent(
      owner,
      run.teamName,
      async () => blocked.promise,
      abort.signal
    );
    const rejected = expect(launching).rejects.toThrow('TEST context revoked');
    await expect.poll(() => lifecycle.registry.findSnapshot(run.teamName)?.state).toBe('preparing');
    abort.abort(new Error('TEST context revoked'));
    await rejected;
    blocked.resolve(roster);
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      resources: 'released',
      error: 'TEST context revoked',
    });
  });

  it('rejects an already revoked launch signal before creating a run or reading settings', async () => {
    const { lifecycle, starts } = setup();
    const abort = new AbortController();
    abort.abort(new Error('TEST stale admission'));
    let reads = 0;
    await expect(
      lifecycle.teams.launchCurrent(
        owner,
        run.teamName,
        () => {
          reads++;
          return Promise.resolve(roster);
        },
        abort.signal
      )
    ).rejects.toThrow('TEST stale admission');
    expect(lifecycle.registry.findSnapshot(run.teamName)).toBeNull();
    expect(reads).toBe(0);
    expect(starts).toEqual([]);
  });

  it('rejects foreign team-name launch before reading settings or changing the current snapshot', async () => {
    const { lifecycle } = setup();
    const first = await lifecycle.teams.launchCurrent(owner, run.teamName, () =>
      Promise.resolve(roster)
    );
    const before = lifecycle.snapshot(run.teamName);
    let reads = 0;
    await expect(
      lifecycle.teams.launchCurrent({ ...owner, connectionGeneration: 999 }, run.teamName, () => {
        reads++;
        return Promise.resolve(roster);
      })
    ).rejects.toThrow('Foreign');
    expect(reads).toBe(0);
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
    await lifecycle.teams.stop(first.run);
  });

  it('launches the configured lead and members once through the same lifecycle owner', async () => {
    const { lifecycle, starts } = setup();
    const [first, second] = await Promise.all([
      lifecycle.teams.launch(run, roster),
      lifecycle.teams.launch(run, roster),
    ]);
    await settle(lifecycle);
    expect(first.run).toEqual(run);
    expect(second).toEqual(first);
    expect(starts.sort()).toEqual(['builder', 'team-lead']);
    expect(
      Object.values(lifecycle.snapshot(run.teamName).members).every(
        (member) => member.phase === 'ready'
      )
    ).toBe(true);
    await expect(
      lifecycle.leadStart.execute(first.leadCredential, { memberName: 'team-lead' })
    ).rejects.toThrow('lead');
  });

  it('revokes the lead capability and stops every member before admitting another run', async () => {
    const { lifecycle, stops } = setup();
    const launch = await lifecycle.teams.launch(run, roster);
    await settle(lifecycle);
    await lifecycle.teams.stop(run);
    expect(stops.sort()).toEqual(['builder', 'team-lead']);
    expect(lifecycle.snapshot(run.teamName).desired).toBe('stopped');
    expect(lifecycle.registry.recoveryCandidates(run.teamName)).toEqual([]);
    await expect(
      lifecycle.leadStart.execute(launch.leadCredential, { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
    await expect(lifecycle.commands.start(run, 'builder')).rejects.toThrow('stopped');
    const next = await lifecycle.teams.launch({ ...run, runId: 'next-run' }, roster);
    expect(next.leadCredential).not.toBe(launch.leadCredential);
  });

  it('can cancel while launch settings are still loading, without spawning a late process', async () => {
    const pending = deferred<ConfiguredMemberLaunch | null>();
    const { lifecycle, starts } = setup(async (_team, memberName) =>
      memberName === 'builder' ? pending.promise : null
    );
    await lifecycle.teams.launch(run, roster);
    const stopped = lifecycle.teams.stop(run);
    await expect(stopped).resolves.toBeUndefined();
    pending.resolve({
      team: run,
      memberName: 'builder',
      configurationRevision: 'TEST-revision',
      providerId: 'TEST',
      model: null,
      workingDirectory: 'TEST',
      instructions: 'TEST',
    });
    await settle(lifecycle);
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(run.teamName).members.builder.phase).toBe('stopped');
  });

  it('marks every member intentionally stopped before waiting on one process termination', async () => {
    const blocked = deferred<void>();
    const handles = new Map<string, OwnedMemberProcess>();
    const events = new Map<string, MemberRuntimeEvents>();
    const pendingStops: string[] = [];
    const actual = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember(team, memberName) {
          return {
            team,
            memberName,
            configurationRevision: 'TEST-revision',
            providerId: 'TEST',
            model: null,
            workingDirectory: 'TEST',
            instructions: 'TEST',
          };
        },
      },
      runtime: {
        async spawn(settings) {
          const handle: OwnedMemberProcess = {
            identity: { pid: handles.size + 200, birthId: settings.memberName },
            async writeInput() {},
            subscribe(listener) {
              events.set(settings.memberName, listener);
              return () => undefined;
            },
            async stop() {
              pendingStops.push(settings.memberName);
              if (settings.memberName === 'team-lead') await blocked.promise;
              events.get(settings.memberName)?.exited({ code: 0, signal: null });
              events.get(settings.memberName)?.released();
            },
          };
          handles.set(settings.memberName, handle);
          return handle;
        },
      },
    });
    await actual.teams.launch(run, roster);
    await settle(actual);
    const stopping = actual.teams.stop(run);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      Object.values(actual.snapshot(run.teamName).members).every(
        (member) => member.desired === 'stopped'
      )
    ).toBe(true);
    expect(actual.registry.recoveryCandidates(run.teamName)).toEqual([]);
    blocked.resolve();
    await stopping;
    expect(pendingStops.sort()).toEqual(['builder', 'team-lead']);
  });

  it('does not re-admit failed members or change the snapshot when launch is repeated', async () => {
    const { lifecycle, events, starts } = setup();
    const launch = await lifecycle.teams.launch(run, roster);
    await settle(lifecycle);
    events.get('builder')?.exited({ code: 1, signal: null });
    const before = lifecycle.snapshot(run.teamName);
    expect(await lifecycle.teams.launch(run, roster)).toEqual(launch);
    expect(lifecycle.snapshot(run.teamName)).toEqual(before);
    expect(starts).toEqual(['team-lead', 'builder']);
  });

  it('cancels a configured launch while the canonical roster is loading, without admitting it later', async () => {
    const pending = deferred<void>();
    const { lifecycle, starts } = setup();
    let loading = false;
    const launching = lifecycle.teams.launchConfigured(run, async () => {
      loading = true;
      await pending.promise;
      return roster;
    });
    const rejected = expect(launching).rejects.toThrow();
    await expect.poll(() => loading).toBe(true);
    await lifecycle.teams.stop(run);
    pending.resolve();
    await rejected;
    expect(starts).toEqual([]);
    const next = { ...run, runId: 'TEST-next-run' };
    expect((await lifecycle.teams.launch(next, roster)).run).toEqual(next);
  });

  it('exposes pending canonical preparation and its cancellation in the same versioned snapshot', async () => {
    const pending = deferred<typeof roster>();
    const { lifecycle, starts } = setup();
    let reading = false;
    const launching = lifecycle.teams.launchConfigured(run, async () => {
      reading = true;
      return pending.promise;
    });
    const rejected = expect(launching).rejects.toThrow();
    await expect.poll(() => reading).toBe(true);
    const preparing = lifecycle.snapshot(run.teamName);
    expect(preparing).toMatchObject({
      identity: run,
      desired: 'running',
      resources: 'preparing',
      state: 'preparing',
      error: null,
      members: {},
    });
    expect(lifecycle.snapshot(run.teamName)).toEqual(preparing);
    await lifecycle.teams.stop(run);
    await rejected;
    const stopped = lifecycle.snapshot(run.teamName);
    expect(stopped).toMatchObject({ desired: 'stopped', resources: 'released', error: null });
    expect(stopped.version).toBeGreaterThan(preparing.version);
    pending.resolve(roster);
    await Promise.resolve();
    expect(lifecycle.snapshot(run.teamName)).toEqual(stopped);
    expect(starts).toEqual([]);
  });

  it('retains a preparation failure in the snapshot and releases admission for a new run', async () => {
    const { lifecycle, starts } = setup();
    await expect(
      lifecycle.teams.launchConfigured(run, async () => {
        throw new Error('TEST canonical metadata unavailable');
      })
    ).rejects.toThrow('TEST canonical metadata unavailable');
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      desired: 'running',
      resources: 'released',
      error: 'TEST canonical metadata unavailable',
      members: {},
    });
    expect(starts).toEqual([]);
    const next = { ...run, runId: 'TEST-after-read-failure' };
    await lifecycle.teams.launch(next, roster);
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      identity: next,
      resources: 'held',
      error: null,
    });
  });

  it('does not release resources that a failed canonical read never acquired', async () => {
    let releases = 0;
    const actual = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember() {
          return null;
        },
      },
      runtime: {
        async spawn() {
          throw new Error('TEST no process');
        },
      },
      teamResources: {
        async prepare() {
          throw new Error('TEST must not prepare');
        },
        async release() {
          releases++;
          throw new Error('TEST no native claim exists');
        },
      },
    });
    await expect(
      actual.teams.launchConfigured(run, async () => {
        throw new Error('TEST missing canonical metadata');
      })
    ).rejects.toThrow('metadata');
    await actual.teams.stop(run);
    await actual.teams.stop(run);
    expect(releases).toBe(0);
    expect(actual.snapshot(run.teamName)).toMatchObject({
      desired: 'stopped',
      state: 'stopped',
      resources: 'released',
      error: null,
    });
  });

  it('shares a pending configured launch without running a second settings reader', async () => {
    const pending = deferred<typeof roster>();
    const { lifecycle, starts } = setup();
    let reads = 0;
    const load = async () => {
      reads++;
      return pending.promise;
    };
    const first = lifecycle.teams.launchConfigured(run, load);
    const second = lifecycle.teams.launchConfigured(run, load);
    await expect.poll(() => reads).toBe(1);
    pending.resolve(roster);
    expect(await first).toEqual(await second);
    await settle(lifecycle);
    expect(starts.sort()).toEqual(['builder', 'team-lead']);
    expect(reads).toBe(1);
  });

  it('waits for mutating preparation and releases its claim after cancellation before admitting another run', async () => {
    const prepared = deferred<void>();
    const released = deferred<void>();
    const order: string[] = [];
    const lifecycle = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember() {
          throw new Error('Cancelled preparation must not spawn');
        },
      },
      runtime: {
        async spawn() {
          throw new Error('Cancelled preparation must not spawn');
        },
      },
      teamResources: {
        async prepare() {
          order.push('prepare');
          await prepared.promise;
          order.push('prepared');
        },
        async release() {
          order.push('release');
          await released.promise;
          order.push('released');
        },
      },
    });
    const launching = lifecycle.teams.launch(run, roster);
    const rejected = expect(launching).rejects.toThrow();
    await expect.poll(() => order).toEqual(['prepare']);
    let stopped = false;
    const stopping = lifecycle.teams.stop(run).then(() => {
      stopped = true;
    });
    await expect(lifecycle.teams.launch({ ...run, runId: 'TEST-next' }, roster)).rejects.toThrow(
      'pending'
    );
    expect(stopped).toBe(false);
    prepared.resolve();
    await expect.poll(() => order).toContain('release');
    expect(stopped).toBe(false);
    released.resolve();
    await stopping;
    await rejected;
    expect(order).toEqual(['prepare', 'prepared', 'release', 'released']);
  });

  it('keeps a stopped team reserved while its run resources are releasing', async () => {
    const pending = deferred<void>();
    let releasing = false;
    const actual = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember() {
          return null;
        },
      },
      runtime: {
        async spawn() {
          throw new Error('No settings');
        },
      },
      teamResources: {
        async prepare() {},
        async release() {
          releasing = true;
          await pending.promise;
        },
      },
    });
    await actual.teams.launch(run, roster);
    await settle(actual);
    const stopping = actual.teams.stop(run);
    await expect.poll(() => releasing).toBe(true);
    expect(actual.snapshot(run.teamName)).toMatchObject({
      desired: 'stopped',
      resources: 'releasing',
      error: null,
    });
    await expect(actual.teams.launch({ ...run, runId: 'TEST-next' }, roster)).rejects.toThrow(
      'releasing'
    );
    pending.resolve();
    await stopping;
    expect((await actual.teams.launch({ ...run, runId: 'TEST-next' }, roster)).run.runId).toBe(
      'TEST-next'
    );
  });

  it('retains failed run-resource release in the snapshot and blocks replacement until cleanup succeeds', async () => {
    let releaseFails = true;
    const actual = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember() {
          return null;
        },
      },
      runtime: {
        async spawn() {
          throw new Error('TEST no process');
        },
      },
      teamResources: {
        async prepare() {},
        async release() {
          if (releaseFails) throw new Error('TEST config claim remains');
        },
      },
    });
    await actual.teams.launch(run, roster);
    await settle(actual);
    await expect(actual.teams.stop(run)).rejects.toThrow('termination');
    const failed = actual.snapshot(run.teamName);
    expect(failed).toMatchObject({
      desired: 'stopped',
      resources: 'release-failed',
      error: 'TEST config claim remains',
    });
    await expect(actual.teams.launch({ ...run, runId: 'TEST-next' }, roster)).rejects.toThrow(
      'released'
    );
    expect(actual.snapshot(run.teamName)).toEqual(failed);
    releaseFails = false;
    await actual.teams.stop(run);
    expect(actual.snapshot(run.teamName)).toMatchObject({ resources: 'released', error: null });
    await actual.teams.launch({ ...run, runId: 'TEST-next' }, roster);
  });

  it('records cancelled preparation cleanup failure even before the roster was admitted', async () => {
    const prepared = deferred<void>();
    let preparing = false;
    let releaseFails = true;
    const actual = createMemberLifecycle({
      owner,
      settings: {
        async findConfiguredMember() {
          return null;
        },
      },
      runtime: {
        async spawn() {
          throw new Error('TEST no process');
        },
      },
      teamResources: {
        async prepare() {
          preparing = true;
          await prepared.promise;
        },
        async release() {
          if (releaseFails) throw new Error('TEST pending claim remains');
        },
      },
    });
    const launching = actual.teams.launch(run, roster);
    const rejectedLaunch = expect(launching).rejects.toThrow('not released');
    await expect.poll(() => preparing).toBe(true);
    const stopping = actual.teams.stop(run);
    const rejectedStop = expect(stopping).rejects.toThrow('termination');
    prepared.resolve();
    await Promise.all([rejectedLaunch, rejectedStop]);
    expect(actual.snapshot(run.teamName)).toMatchObject({
      desired: 'stopped',
      resources: 'release-failed',
      error: 'TEST pending claim remains',
      members: {},
    });
    await expect(actual.teams.launch({ ...run, runId: 'TEST-next' }, roster)).rejects.toThrow(
      'released'
    );
    releaseFails = false;
    await actual.teams.stop(run);
    expect(actual.snapshot(run.teamName)).toMatchObject({ resources: 'released', error: null });
  });

  it('rejects a foreign configured launch before reading its settings', async () => {
    const { lifecycle } = setup();
    let reads = 0;
    await expect(
      lifecycle.teams.launchConfigured({ ...run, appInstanceId: 'foreign' }, async () => {
        reads++;
        return roster;
      })
    ).rejects.toThrow('Foreign');
    expect(reads).toBe(0);
  });

  it('rejects a changed roster or foreign owner for an already configured run', async () => {
    const { lifecycle } = setup();
    await lifecycle.teams.launch(run, roster);
    await expect(
      lifecycle.teams.launch(run, [...roster, { memberName: 'extra', role: 'member' }])
    ).rejects.toThrow('roster');
    await expect(lifecycle.teams.stop({ ...run, appInstanceId: 'foreign' })).rejects.toThrow(
      'Foreign'
    );
    expect(lifecycle.snapshot(run.teamName).desired).toBe('running');
  });
});
