import { describe, expect, it } from 'vitest';

import { MemberLifecycleCommands } from '../../../../src/features/team-provisioning/core/application/commands/MemberLifecycleCommands';
import { OwnedRuntimeCleanupError } from '../../../../src/features/team-provisioning/core/application/OwnedRuntimeCleanupError';
import { TeamOperationQueue } from '../../../../src/features/team-provisioning/core/application/TeamOperationQueue';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

import type {
  MemberRuntimeEvents,
  MemberRuntimePort,
  OwnedMemberProcess,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = { appInstanceId: 'app-1', dataRootFingerprint: 'root', connectionGeneration: 1 };
const run = { ...owner, teamName: 'TEST-team', runId: 'run-1' };

function setup(runtime: MemberRuntimePort, providerId = 'anthropic') {
  const registry = new MemberLifecycleRegistry(owner);
  registry.configureTeam(run, [{ memberName: 'builder', role: 'member' }]);
  let sequence = 0;
  const commands = new MemberLifecycleCommands({
    registry,
    gate: new TeamOperationQueue(),
    nextOperationId: () => `operation-${++sequence}`,
    settings: {
      async findConfiguredMember(team, memberName) {
        return {
          team,
          memberName,
          configurationRevision: 'revision-1',
          providerId,
          model: null,
          workingDirectory: 'TEST-workspace',
          instructions: 'Test worker',
        };
      },
    },
    runtime,
  });
  return { registry, commands };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function processHandle(stops: string[]): OwnedMemberProcess {
  return {
    identity: { pid: 123, birthId: 'birth-1' },
    subscribe: () => () => undefined,
    async writeInput() {},
    async stop() {
      stops.push('stop');
    },
  };
}

describe('configured member start command', () => {
  it('launches once for concurrent requests, then admits no duplicate', async () => {
    const spawned = deferred<OwnedMemberProcess>();
    let starts = 0;
    let events: MemberRuntimeEvents | undefined;
    const { registry, commands } = setup({
      async spawn() {
        starts++;
        return spawned.promise;
      },
    });
    const [first, second] = await Promise.all([
      commands.start(run, 'builder'),
      commands.start(run, 'builder'),
    ]);
    expect(first.kind).toBe('launch');
    expect(second).toMatchObject({
      kind: 'pending',
      token: first.kind === 'launch' ? first.token : undefined,
    });
    expect(starts).toBe(1);
    spawned.resolve({
      ...processHandle([]),
      subscribe(callbacks) {
        events = callbacks;
        return () => undefined;
      },
    });
    await commands.settled(run, 'builder');
    events?.connected();
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('ready');
    expect(await commands.start(run, 'builder')).toEqual({ kind: 'already-running' });
    expect(starts).toBe(1);
  });

  it('cancels an in-flight launch and stops exactly its late process handle', async () => {
    const spawned = deferred<OwnedMemberProcess>();
    const stops: string[] = [];
    let signal: AbortSignal | undefined;
    const { registry, commands } = setup({
      async spawn(_s, _t, abort) {
        signal = abort;
        return spawned.promise;
      },
    });
    await commands.start(run, 'builder');
    await expect.poll(() => signal !== undefined).toBe(true);
    let stopped = false;
    const stopping = commands.stop(run, 'builder').then(() => {
      stopped = true;
    });
    await expect.poll(() => signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    spawned.resolve(processHandle(stops));
    await stopping;
    await commands.settled(run, 'builder');
    expect(stops).toEqual(['stop']);
    expect(registry.snapshot(run.teamName).members.builder.desired).toBe('stopped');
    expect(registry.recoveryCandidates(run.teamName)).toEqual([]);
  });

  it('retains an exit observed before the application subscribes to its process', async () => {
    const { registry, commands } = setup({
      async spawn() {
        return {
          ...processHandle([]),
          subscribe(events) {
            events.exited({ code: 1, signal: null });
            return () => undefined;
          },
        };
      },
    });
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('exited');
  });

  it('does not overlap a replacement attempt with the exited process resource release', async () => {
    let events!: MemberRuntimeEvents;
    let starts = 0;
    const { registry, commands } = setup({
      async spawn() {
        starts++;
        return {
          ...processHandle([]),
          subscribe(listener) {
            events = listener;
            return () => undefined;
          },
        };
      },
    });
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    events.exited({ code: 0, signal: null });
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      process: null,
      resources: 'releasing',
    });
    expect(registry.recoveryCandidates(run.teamName)).toEqual([]);
    expect(await commands.start(run, 'builder')).toEqual({ kind: 'stopping' });
    expect(starts).toBe(1);
    const version = registry.snapshot(run.teamName).version;
    events.released();
    expect(registry.snapshot(run.teamName).members.builder.resources).toBe('released');
    expect(registry.snapshot(run.teamName).version).toBe(version + 1);
    expect(registry.recoveryCandidates(run.teamName)).toEqual(['builder']);
    expect((await commands.start(run, 'builder')).kind).toBe('launch');
    await commands.settled(run, 'builder');
    expect(starts).toBe(2);
  });

  it('records launch rejection without an unhandled promise or a second execution route', async () => {
    const { registry, commands } = setup({
      async spawn() {
        throw new Error('Provider refused start');
      },
    });
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      error: 'Provider refused start',
    });
  });

  it('retains pre-spawn cleanup ownership and blocks another attempt until the same cleanup succeeds', async () => {
    let blocked = true;
    let starts = 0;
    let cleanups = 0;
    const { registry, commands } = setup({
      async spawn() {
        starts++;
        throw new OwnedRuntimeCleanupError(new Error('TEST setup failed'), async () => {
          cleanups++;
          if (blocked) throw new Error('TEST private files locked');
        });
      },
    });
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      resources: 'release-failed',
    });
    expect(registry.recoveryCandidates(run.teamName)).toEqual([]);
    expect(commands.hasUnreleased(run)).toBe(true);
    expect(await commands.start(run, 'builder')).toEqual({ kind: 'stopping' });
    expect(starts).toBe(1);
    await expect(commands.stop(run, 'builder')).rejects.toThrow('termination');
    expect(commands.hasUnreleased(run)).toBe(true);
    blocked = false;
    await Promise.all([commands.stop(run, 'builder'), commands.stop(run, 'builder')]);
    expect(commands.hasUnreleased(run)).toBe(false);
    expect(registry.snapshot(run.teamName).members.builder.resources).toBe('released');
    expect(cleanups).toBe(2);
    expect((await commands.start(run, 'builder')).kind).toBe('launch');
    await commands.settled(run, 'builder');
    expect(starts).toBe(2);
  });

  it('releases an exact late process even when the registry rejects its stale spawn observation', async () => {
    const stops: string[] = [];
    let events!: MemberRuntimeEvents;
    const { registry, commands } = setup({
      async spawn() {
        return {
          ...processHandle(stops),
          subscribe(listener) {
            events = listener;
            return () => undefined;
          },
          async stop() {
            stops.push('stop');
            events.exited({ code: 0, signal: null });
            events.released();
          },
        };
      },
    });
    // РИСК: injected refusal exercises late-owner disposal, not a real desktop reconnect.
    const observeSpawn = registry.observeSpawn.bind(registry);
    registry.observeSpawn = (token) => {
      observeSpawn(token, { pid: 456, birthId: 'TEST-current-owner' });
      return false;
    };
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    registry.observeSpawn = observeSpawn;
    expect(stops).toEqual(['stop']);
    expect(commands.hasUnreleased(run)).toBe(false);
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      process: { pid: 456, birthId: 'TEST-current-owner' },
      resources: 'held',
      phase: 'connecting',
    });
  });

  it('does not turn a prior runtime error into cleanup debt after exact exit and resource release', async () => {
    let events!: MemberRuntimeEvents;
    const { registry, commands } = setup({
      async spawn() {
        return {
          ...processHandle([]),
          subscribe(listener) {
            events = listener;
            return () => undefined;
          },
          async stop() {
            events.exited({ code: 1, signal: null });
            events.released();
            throw new Error('TEST prior runtime error');
          },
        };
      },
    });
    await commands.start(run, 'builder');
    await commands.settled(run, 'builder');
    events.failed('TEST prior runtime error');
    await expect(commands.stop(run, 'builder')).resolves.toBeUndefined();
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      process: null,
      resources: 'released',
      phase: 'stopped',
      error: 'TEST prior runtime error',
    });
    expect(commands.hasUnreleased(run)).toBe(false);
  });

  it('fences input delivery against stopping, replaced generations, and foreign runs', async () => {
    const blocked = deferred<void>();
    const writes: string[] = [];
    const { commands } = setup({
      async spawn() {
        return {
          ...processHandle([]),
          async writeInput(line) {
            writes.push(line);
            await blocked.promise;
          },
        };
      },
    });
    const admitted = await commands.start(run, 'builder');
    if (admitted.kind !== 'launch') throw new Error('Expected test launch');
    await commands.settled(run, 'builder');
    await expect(commands.writeInput({ ...admitted.token, generation: 2 }, 'TEST')).rejects.toThrow(
      'current'
    );
    await expect(
      commands.writeInput({ ...admitted.token, appInstanceId: 'foreign' }, 'TEST')
    ).rejects.toThrow();
    const written = commands.writeInput(admitted.token, 'TEST-input');
    await expect.poll(() => writes.length).toBe(1);
    // Stdin backpressure must not hold the gate needed by stop.
    await commands.stop(run, 'builder');
    await expect(commands.writeInput(admitted.token, 'TEST-after-stop')).rejects.toThrow('current');
    blocked.resolve();
    await written;
    expect(writes).toEqual(['TEST-input']);
  });

  it('does not call a runtime for an unconfigured target', async () => {
    let starts = 0;
    const { commands } = setup({
      async spawn() {
        starts++;
        return processHandle([]);
      },
    });
    await expect(commands.start(run, 'invented')).rejects.toThrow('not configured');
    expect(starts).toBe(0);
  });

  it('starts an adapter lane, applies observations and releases it', async () => {
    let events: MemberRuntimeEvents | undefined;
    const stops: string[] = [];
    const lane = {
      laneId: 'TEST-lane',
      sessionId: 'TEST-session',
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    };
    const { registry, commands } = setup(
      {
        kind: () => 'lane',
        async spawn() {
          throw new Error('process spawn must not be used for a lane');
        },
        async startLane() {
          return {
            lane,
            subscribe(next) {
              events = next;
              return () => undefined;
            },
            async writeInput() {},
            async stop() {
              stops.push('stop');
            },
          };
        },
      },
      'opencode'
    );
    const admission = await commands.start(run, 'builder');
    if (admission.kind !== 'launch') throw new Error('Expected a launch admission');
    await commands.settled(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'ready',
      process: null,
      lane,
    });
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);

    events?.laneObserved?.({ ...lane, bootstrapConfirmed: false, permissionBlocked: true });
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('connecting');
    expect(registry.aliveTeamNames()).toEqual([]);
    events?.laneObserved?.({ ...lane, bootstrapConfirmed: false, permissionBlocked: false });
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);

    await commands.writeInput(admission.token, 'TEST input');
    await commands.stop(run, 'builder');
    expect(stops).toEqual(['stop']);

    events?.laneLost?.('TEST lane lost');
    events?.released?.();
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'stopped',
      lane: null,
      error: null,
      resources: 'released',
    });
  });

  it('reports an unexpected lane loss as a failed attempt', async () => {
    let events: MemberRuntimeEvents | undefined;
    const lane = {
      laneId: 'TEST-lane',
      sessionId: null,
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    };
    const { registry, commands } = setup(
      {
        kind: () => 'lane',
        async spawn() {
          throw new Error('process spawn must not be used for a lane');
        },
        async startLane() {
          return {
            lane,
            subscribe(next) {
              events = next;
              return () => undefined;
            },
            async writeInput() {},
            async stop() {},
          };
        },
      },
      'opencode'
    );
    const admission = await commands.start(run, 'builder');
    if (admission.kind !== 'launch') throw new Error('Expected a launch admission');
    await commands.settled(run, 'builder');
    events?.laneLost?.('TEST lane lost');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'exited',
      lane: null,
      error: 'TEST lane lost',
    });
  });

  it('fails a lane start when the runtime has no lane implementation', async () => {
    const { registry, commands } = setup(
      {
        kind: () => 'lane',
        async spawn() {
          throw new Error('process spawn must not be used for a lane');
        },
      },
      'opencode'
    );
    const admission = await commands.start(run, 'builder');
    if (admission.kind !== 'launch') throw new Error('Expected a launch admission');
    await commands.settled(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      error: 'Adapter lane runtime is not wired for this provider',
    });
  });
});
