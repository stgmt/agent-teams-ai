// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createBoundLifecycleCommands } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleCommands';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { TeamRunIdentity } from '../../../../src/features/team-provisioning/contracts';
import type {
  MemberRuntimeEvents,
  TeamRunResourcesPort,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

// РИСК: controlled process events prove command admission, not native provider or Electron execution.
function setup(resources?: TeamRunResourcesPort) {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  const events = new Map<string, MemberRuntimeEvents>();
  const starts: string[] = [];
  const reads: TeamRunIdentity[] = [];
  let read: () => Promise<void> = () => Promise.resolve();
  let terminate: (events: MemberRuntimeEvents) => Promise<void> = (listener) => {
    listener.exited({ code: 0, signal: null });
    listener.released();
    return Promise.resolve();
  };
  const lifecycle = createMemberLifecycle({
    owner,
    teamResources: resources,
    settings: {
      findConfiguredMember(team, memberName) {
        return Promise.resolve({
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
        });
      },
    },
    runtime: {
      spawn(settings) {
        starts.push(settings.memberName);
        return Promise.resolve({
          identity: { pid: 100 + starts.length, birthId: `TEST-${starts.length}` },
          writeInput: () => Promise.resolve(),
          subscribe(listener: MemberRuntimeEvents) {
            events.set(settings.memberName, listener);
            listener.connected();
            return () => events.delete(settings.memberName);
          },
          stop() {
            return terminate(events.get(settings.memberName)!);
          },
        });
      },
    },
  });
  const commands = createBoundLifecycleCommands({
    owner,
    source: {
      launchCurrent: (...args) => lifecycle.teams.launchCurrent(...args),
      stop: (run) => lifecycle.teams.stop(run),
      restart: (target, signal) => lifecycle.commands.restart(target, signal),
      skip: (target, signal) => lifecycle.commands.skip(target, signal),
    },
    load: async (run) => {
      reads.push(run);
      await read();
      return [
        { memberName: 'team-lead', role: 'lead' },
        { memberName: 'builder', role: 'member' },
      ];
    },
    invalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
  const request = { expectedContext: owner, teamName: 'test-team' };
  return {
    commands,
    lifecycle,
    context,
    starts,
    reads,
    request,
    setRead: (operation: typeof read) => {
      read = operation;
    },
    setTerminate: (operation: typeof terminate) => {
      terminate = operation;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function settle(lifecycle: ReturnType<typeof createMemberLifecycle>, run: TeamRunIdentity) {
  await Promise.all(['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name)));
}

describe('context-bound configured launch and exact-run stop', () => {
  it('restarts only the exact observed member generation without accepting launch settings', async () => {
    const { commands, request, lifecycle, starts, reads } = setup();
    const launched = await commands.launch(request);
    await settle(lifecycle, launched.run);
    const lead = lifecycle.snapshot(request.teamName).members['team-lead'];
    const target = { ...request, runId: launched.run.runId, memberName: 'builder', generation: 1 };
    const [first, second] = await Promise.all([
      commands.restartMember(target),
      commands.restartMember(target),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ kind: 'launch', token: { generation: 2 } });
    await settle(lifecycle, launched.run);
    expect(starts).toEqual(['team-lead', 'builder', 'builder']);
    expect(reads).toHaveLength(1);
    expect(lifecycle.snapshot(request.teamName).members['team-lead']).toEqual(lead);
    await expect(commands.restartMember(target)).rejects.toThrow('generation');
    await commands.stop({ ...request, runId: launched.run.runId });
  });

  it.each([
    { memberName: '../other' },
    { memberName: ' builder' },
    { memberName: 'builder ' },
    { memberName: 'team-lead' },
    { generation: -1 },
    { generation: 1.5 },
    { generation: '1' },
    { providerId: 'anthropic' },
    { model: 'TEST-other-model' },
    { cwd: 'TEST-other-directory' },
    { runId: '' },
    { runId: ' TEST-run' },
  ])(
    'rejects invalid restart target fields before changing current runtime: %j',
    async (fields) => {
      const { commands, request, lifecycle, starts } = setup();
      const launched = await commands.launch(request);
      await settle(lifecycle, launched.run);
      const before = lifecycle.snapshot(request.teamName);
      await expect(
        commands.restartMember({
          ...request,
          runId: launched.run.runId,
          memberName: 'builder',
          generation: 1,
          ...fields,
        })
      ).rejects.toThrow();
      expect(lifecycle.snapshot(request.teamName)).toEqual(before);
      expect(starts).toHaveLength(2);
      await commands.stop({ ...request, runId: launched.run.runId });
    }
  );

  it('revokes replacement on root change but drains exact termination before admission closes', async () => {
    const { commands, request, lifecycle, starts, context, setTerminate } = setup();
    const { run } = await commands.launch(request);
    await settle(lifecycle, run);
    const entered = deferred();
    const terminated = deferred();
    setTerminate(async (events) => {
      entered.resolve();
      await terminated.promise;
      events.exited({ code: 0, signal: null });
      events.released();
    });
    const restarting = commands.restartMember({
      ...request,
      runId: run.runId,
      memberName: 'builder',
      generation: 1,
    });
    const rejected = expect(restarting).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await entered.promise;
    let drained = false;
    const closing = context.closeAdmission().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(starts).toHaveLength(2);
    terminated.resolve();
    await Promise.all([closing, rejected]);
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(request.teamName).members.builder).toMatchObject({
      generation: 1,
      desired: 'stopped',
      process: null,
      resources: 'released',
    });
    await lifecycle.teams.stop(run);
  });

  it('rejects an already invalidated restart before stopping an existing member', async () => {
    const { commands, request, lifecycle, starts, context } = setup();
    const { run } = await commands.launch(request);
    await settle(lifecycle, run);
    const before = lifecycle.snapshot(request.teamName);
    context.transportReplaced();
    await expect(
      commands.restartMember({ ...request, runId: run.runId, memberName: 'builder', generation: 1 })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(starts).toHaveLength(2);
    expect(lifecycle.snapshot(request.teamName)).toEqual(before);
    await lifecycle.teams.stop(run);
  });

  it('coalesces team-name requests into the application-selected run without exposing lead authority', async () => {
    const { commands, request, lifecycle, starts, reads } = setup();
    const [first, second] = await Promise.all([commands.launch(request), commands.launch(request)]);
    expect(first).toEqual(second);
    expect(Object.keys(first)).toEqual(['run']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.run)).toBe(true);
    expect(first.run).toMatchObject({ ...request.expectedContext, teamName: request.teamName });
    expect(first.run.runId).toBeTruthy();
    expect(reads).toEqual([first.run]);
    await settle(lifecycle, first.run);
    expect(starts.toSorted((a, b) => a.localeCompare(b))).toEqual(['builder', 'team-lead']);
    const before = lifecycle.snapshot(request.teamName);
    expect(await commands.launch(request)).toEqual(first);
    expect(lifecycle.snapshot(request.teamName)).toEqual(before);
    expect(reads).toHaveLength(1);
    await commands.stop({ ...request, runId: first.run.runId });
  });

  it.each([
    null,
    {},
    { teamName: '../other' },
    { teamName: ' test-team' },
    { providerId: 'anthropic' },
    { runId: 'TEST-caller-run' },
    { memberName: 'invented' },
    { cwd: 'TEST-caller-directory' },
    {
      expectedContext: {
        appInstanceId: 'foreign',
        dataRootFingerprint: 'root',
        connectionGeneration: 1,
      },
    },
  ])(
    'rejects malformed or authority-extending launch input before reading canonical settings: %j',
    async (patch) => {
      const { commands, request, lifecycle, reads, starts } = setup();
      let input: unknown = null;
      if (patch !== null) input = Object.keys(patch).length === 0 ? {} : { ...request, ...patch };
      await expect(commands.launch(input)).rejects.toThrow();
      expect(reads).toEqual([]);
      expect(starts).toEqual([]);
      expect(lifecycle.registry.findSnapshot(request.teamName)).toBeNull();
    }
  );

  it('stops the exact selected run but rejects an old stop after its successor has started', async () => {
    const { commands, request, lifecycle } = setup();
    const first = await commands.launch(request);
    const stop = { ...request, runId: first.run.runId };
    await commands.stop(stop);
    await commands.stop(stop);
    const next = await commands.launch(request);
    expect(next.run.runId).not.toBe(first.run.runId);
    const before = lifecycle.snapshot(request.teamName);
    await expect(commands.stop(stop)).rejects.toThrow('stale');
    expect(lifecycle.snapshot(request.teamName)).toEqual(before);
    await commands.stop({ ...request, runId: next.run.runId });
  });

  it.each([
    {},
    { runId: '' },
    { runId: ' TEST-run' },
    { runId: 'TEST-run', providerId: 'anthropic' },
  ])('requires an exact run identity for stop: %j', async (patch) => {
    const { commands, request, lifecycle } = setup();
    const first = await commands.launch(request);
    const before = lifecycle.snapshot(request.teamName);
    await expect(commands.stop({ ...request, ...patch })).rejects.toThrow();
    expect(lifecycle.snapshot(request.teamName)).toEqual(before);
    await commands.stop({ ...request, runId: first.run.runId });
  });

  it('revokes a blocked settings read so changing the application root can drain', async () => {
    const { commands, request, context, lifecycle, reads, starts, setRead } = setup();
    const blocked = deferred();
    setRead(async () => blocked.promise);
    const launching = commands.launch(request);
    const rejected = expect(launching).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect.poll(() => reads.length).toBe(1);
    await context.closeAdmission();
    await rejected;
    context.rebind('TEST-next-root');
    blocked.resolve();
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(request.teamName)).toMatchObject({ resources: 'released' });
    await expect(commands.launch(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect(
      commands.launch({ ...request, expectedContext: context.snapshot() })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
  });

  it('keeps root admission until revoked mutating preparation and exact cleanup have physically completed', async () => {
    const prepared = deferred();
    const released = deferred();
    let preparing = false;
    let releasing = false;
    const { commands, request, context, lifecycle, starts } = setup({
      prepare: () => {
        preparing = true;
        return prepared.promise;
      },
      release: () => {
        releasing = true;
        return released.promise;
      },
    });
    const launching = commands.launch(request);
    const rejected = expect(launching).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect.poll(() => preparing).toBe(true);
    let drained = false;
    const closing = context.closeAdmission().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    prepared.resolve();
    await expect.poll(() => releasing).toBe(true);
    expect(drained).toBe(false);
    released.resolve();
    await Promise.all([closing, rejected]);
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(request.teamName)).toMatchObject({ resources: 'released' });
  });

  it('stops a preparing run selected from its authoritative snapshot and ignores late settings', async () => {
    const { commands, request, lifecycle, starts, reads, setRead } = setup();
    const blocked = deferred();
    setRead(async () => blocked.promise);
    const launching = commands.launch(request);
    const rejected = expect(launching).rejects.toThrow();
    await expect.poll(() => reads.length).toBe(1);
    const selected = lifecycle.snapshot(request.teamName).identity;
    await commands.stop({ ...request, runId: selected.runId });
    await rejected;
    blocked.resolve();
    await Promise.resolve();
    expect(starts).toEqual([]);
    expect(lifecycle.snapshot(request.teamName)).toMatchObject({
      desired: 'stopped',
      state: 'stopped',
      resources: 'released',
    });
  });
});
