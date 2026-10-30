// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { createBoundLifecycleQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleQueries';

function setup() {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  const registry = new MemberLifecycleRegistry(owner);
  const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
  registry.configureTeam(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
  ]);
  const queries = createBoundLifecycleQueries({
    owner,
    source: registry,
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
  const request = { expectedContext: owner, teamName: run.teamName };
  return { context, owner, registry, run, queries, request };
}

describe('context-bound authoritative lifecycle reads', () => {
  it('reads the exact registry snapshot without changing its version or launching a process', async () => {
    const { registry, queries, request } = setup();
    const before = registry.snapshot(request.teamName);
    expect(await queries.snapshot(request)).toEqual(before);
    expect(await queries.snapshot(request)).toEqual(before);
    expect(registry.snapshot(request.teamName)).toEqual(before);
    expect(await queries.snapshot({ ...request, teamName: 'test-absent' })).toBeNull();
  });

  it('publishes the same version and identity, including exit after historical readiness', async () => {
    const { registry, run, queries, request } = setup();
    const feed = await queries.watch(request);
    await feed.next();
    const tokens = registry.beginTeamStart(run, () => 'TEST-operation');
    const token = tokens.find((entry) => entry.memberName === 'builder')!;
    const process = { pid: 123, birthId: 'TEST-birth' };
    registry.observeSpawn(token, process);
    registry.observeConnected(token);
    await feed.next();
    const pending = feed.next();
    registry.observeExit(token, process, { code: 7, signal: null });
    const result = await pending;
    expect(result.done).toBe(false);
    expect(result.value).toEqual(await queries.snapshot(request));
    expect(result.value?.members.builder).toMatchObject({
      phase: 'exited',
      process: null,
      everConnected: true,
    });
    await feed.return();
  });

  it('rejects stale context and a different registry owner even after the live context rebinds', async () => {
    const { context, owner, queries, request } = setup();
    await context.closeAdmission();
    context.rebind('TEST-next-root');
    await expect(queries.snapshot(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect(queries.watch(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect(
      queries.snapshot({ ...request, expectedContext: context.snapshot() })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(owner).not.toEqual(context.snapshot());
  });

  it('does not retain a root admission while idle, and detaches the source feed after rebind', async () => {
    const { context, registry, run, queries, request } = setup();
    const feed = await queries.watch(request);
    await feed.next();
    const pending = feed.next();
    const rejected = expect(pending).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await context.closeAdmission();
    context.rebind('TEST-next-root');
    registry.beginTeamStart(run, () => 'TEST-operation');
    await rejected;
    expect(await feed.next()).toMatchObject({ done: true });
    expect(await feed.return()).toMatchObject({ done: true });
  });

  it('revokes a buffered snapshot before another read after transport replacement', async () => {
    const { context, queries, request } = setup();
    const feed = await queries.watch(request);
    context.transportReplaced();
    await expect(feed.next()).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(await feed.next()).toMatchObject({ done: true });
  });

  it('revokes an idle pending feed immediately without waiting for another registry event', async () => {
    const { context, queries, request } = setup();
    const feed = await queries.watch(request);
    await feed.next();
    const pending = feed.next();
    const rejected = expect(pending).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await context.closeAdmission();
    await rejected;
    expect(await feed.next()).toMatchObject({ done: true });
  });

  it('closes a pending read immediately and subscribes before team configuration', async () => {
    const { registry, run, queries, request } = setup();
    const feed = await queries.watch({ ...request, teamName: 'test-later' });
    const pending = feed.next();
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
    registry.configureTeam({ ...run, teamName: 'test-later' }, [
      { memberName: 'team-lead', role: 'lead' },
    ]);
    expect(await feed.next()).toMatchObject({ done: true });
  });

  it('answers alive teams and run ids through the same context fence', async () => {
    const { registry, run, queries, request } = setup();
    expect(await queries.aliveTeamNames()).toEqual([]);
    expect(await queries.aliveRunId(request)).toBeNull();
    const tokens = registry.beginTeamStart(run, () => 'TEST-operation');
    const token = tokens.find((entry) => entry.memberName === 'builder')!;
    const process = { pid: 456, birthId: 'TEST-birth' };
    registry.observeSpawn(token, process);
    expect(await queries.aliveTeamNames()).toEqual([run.teamName]);
    expect(await queries.aliveRunId(request)).toBe(run.runId);
    registry.observeExit(token, process, { code: 0, signal: null });
    expect(await queries.aliveTeamNames()).toEqual([]);
    expect(await queries.aliveRunId(request)).toBeNull();
  });

  it('fences alive reads after the live context rebinds', async () => {
    const { context, queries, request } = setup();
    await context.closeAdmission();
    context.rebind('TEST-next-root');
    await expect(queries.aliveTeamNames()).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect(queries.aliveRunId(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
  });

  it.each([
    null,
    {},
    { teamName: 'test-team', expectedContext: null },
    { teamName: '../other' },
    { teamName: ' test-team' },
    { teamName: 'test-team', memberName: 'builder' },
    { teamName: 'test-team', runId: 'chosen-run' },
  ])('rejects malformed or authority-extending requests: %j', async (input) => {
    const { owner, queries } = setup();
    const request = input && { expectedContext: owner, ...input };
    await expect(queries.snapshot(request)).rejects.toThrow();
    await expect(queries.watch(request)).rejects.toThrow();
    await expect(queries.aliveRunId(request)).rejects.toThrow();
  });

  it('rejects a concurrent feed read without orphaning the first waiter', async () => {
    const { queries, request } = setup();
    const feed = await queries.watch(request);
    await feed.next();
    const pending = feed.next();
    await expect(feed.next()).rejects.toThrow('pending read');
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
  });
});
