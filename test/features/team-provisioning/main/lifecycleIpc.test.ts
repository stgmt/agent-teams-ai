// @vitest-environment node
import { EventEmitter } from 'node:events';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { BOUND_CONTROL_CONTEXT_HEADER } from '../../../../src/features/external-agent-connection/contracts';
import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { registerBoundControlHttp } from '../../../../src/features/external-agent-connection/main/registerBoundControlHttp';
import { TEAM_LIFECYCLE_CHANNELS } from '../../../../src/features/team-provisioning/contracts';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { registerLifecycleIpc } from '../../../../src/features/team-provisioning/main/adapters/input/registerLifecycleIpc';
import { registerLifecycleSnapshotHttp } from '../../../../src/features/team-provisioning/main/adapters/input/registerLifecycleSnapshotHttp';
import { createBoundLifecycleQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleQueries';
import { createTeamLifecycleBridge } from '../../../../src/features/team-provisioning/preload/createTeamLifecycleBridge';
import { watchTeamLifecycle } from '../../../../src/features/team-provisioning/renderer/watchTeamLifecycle';

import type { InvokeIpcWithResult } from '../../../../src/features/team-provisioning/preload/createTeamMemberSettingsBridge';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

// РИСК: EventEmitter fixtures prove document ownership, not packaged Electron delivery.
function renderer() {
  const events = new EventEmitter();
  return Object.assign(events, { mainFrame: {}, isDestroyed: () => false });
}

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
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const sender = renderer();
  let main = sender;
  const dispose = registerLifecycleIpc(ipc, queries, () => main as unknown as WebContents);
  const invoke = async (channel: string, input: unknown, from = sender, frame = from.mainFrame) =>
    handlers.get(channel)!(
      { sender: from, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      input
    );
  const request = { expectedContext: owner, teamName: run.teamName };
  return {
    context,
    registry,
    queries,
    run,
    sender,
    handlers,
    dispose,
    invoke,
    request,
    switchRenderer: () => {
      main = renderer();
      return main;
    },
  };
}

describe('pull-based lifecycle IPC ownership', () => {
  it('delivers the same exited version through HTTP, IPC, preload and renderer iteration', async () => {
    const { context, registry, run, queries, invoke, request, dispose } = setup();
    const server = Fastify({ logger: false });
    registerBoundControlHttp(server, context);
    registerLifecycleSnapshotHttp(server, queries);
    const url = await server.listen({ host: '127.0.0.1', port: 0 });
    const bridge = createTeamLifecycleBridge(invoke as InvokeIpcWithResult);
    const feed = await watchTeamLifecycle(bridge, request);
    try {
      await feed.next();
      const token = registry.beginTeamStart(run, () => 'TEST-operation')[1];
      const process = { pid: 123, birthId: 'TEST-birth' };
      registry.observeSpawn(token, process);
      registry.observeConnected(token);
      await feed.next();
      const update = feed.next();
      registry.observeExit(token, process, { code: 1, signal: null });
      const rendered = await update;
      const http = await server.inject({
        url: '/api/team-runtime/test-team',
        headers: {
          host: new URL(url).host,
          [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(request.expectedContext),
        },
      });
      const ipc = await bridge.getLifecycleSnapshot(request);
      expect(http.statusCode).toBe(200);
      expect(rendered.value).toEqual(ipc);
      expect(ipc).toEqual(http.json());
      expect(ipc).toEqual(registry.snapshot(run.teamName));
      expect(ipc?.members.builder).toMatchObject({
        phase: 'exited',
        process: null,
        everConnected: true,
      });
    } finally {
      await feed.return();
      await dispose();
      await server.close();
    }
  });

  it('returns the same snapshot/version and bounds a slow renderer to the latest value', async () => {
    const { registry, run, invoke, request, dispose } = setup();
    expect(await invoke(TEAM_LIFECYCLE_CHANNELS.snapshot, request)).toEqual(
      registry.snapshot(run.teamName)
    );
    const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    const token = registry.beginTeamStart(run, () => 'TEST-operation')[1];
    registry.observeSpawn(token, { pid: 123, birthId: 'TEST-birth' });
    for (let i = 0; i < 30; i++) {
      registry.observeConnected(token);
      await Promise.resolve();
      registry.observeConnectionLost(token);
      await Promise.resolve();
    }
    expect(await invoke(TEAM_LIFECYCLE_CHANNELS.next, id)).toEqual({
      done: false,
      value: registry.snapshot(run.teamName),
    });
    await dispose();
  });

  it('rejects foreign windows, child frames, and tokens owned by another document', async () => {
    const { invoke, request, switchRenderer, dispose } = setup();
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.snapshot, request, renderer())).rejects.toThrow(
      'renderer'
    );
    const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    const next = switchRenderer();
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.next, id, next)).rejects.toThrow('subscription');
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.close, id, next)).rejects.toThrow('subscription');
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.snapshot, request, next, {})).rejects.toThrow(
      'renderer'
    );
    await dispose();
  });

  it.each(['destroyed', 'render-process-gone', 'navigation'])(
    'closes a pending read and detaches listeners on %s',
    async (event) => {
      const { invoke, request, sender, dispose } = setup();
      const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
      await invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
      const pending = invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
      if (event === 'navigation')
        sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      else sender.emit(event);
      expect(await pending).toMatchObject({ done: true });
      await expect(invoke(TEAM_LIFECYCLE_CHANNELS.next, id)).rejects.toThrow('subscription');
      expect(sender.listenerCount('destroyed')).toBe(0);
      expect(sender.listenerCount('render-process-gone')).toBe(0);
      expect(sender.listenerCount('did-start-navigation')).toBe(0);
      await dispose();
    }
  );

  it('revokes a pending renderer pull when the application context changes, without another process event', async () => {
    const { context, invoke, request, dispose, sender } = setup();
    const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    await invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
    const pending = invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
    const rejected = expect(pending).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await context.closeAdmission();
    await rejected;
    expect(sender.listenerCount('destroyed')).toBe(0);
    await dispose();
  });

  it('does not close on same-document or subframe navigation, but explicit close releases the feed', async () => {
    const { invoke, request, sender, dispose } = setup();
    const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(await invoke(TEAM_LIFECYCLE_CHANNELS.next, id)).toMatchObject({ done: false });
    const pending = invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
    await invoke(TEAM_LIFECYCLE_CHANNELS.close, id);
    expect(await pending).toMatchObject({ done: true });
    expect(sender.listenerCount('destroyed')).toBe(0);
    await dispose();
  });

  it('rejects concurrent pulls without closing the original pending reader', async () => {
    const { invoke, request, registry, run, dispose } = setup();
    const id = await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    await invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
    const pending = invoke(TEAM_LIFECYCLE_CHANNELS.next, id);
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.next, id)).rejects.toThrow('pending read');
    registry.beginTeamStart(run, () => 'TEST-operation');
    expect(await pending).toEqual({ done: false, value: registry.snapshot(run.teamName) });
    await dispose();
  });

  it('does not leak a subscription that finishes opening after the document navigated', async () => {
    const { queries, invoke, request, sender, dispose } = setup();
    const original = queries.watch.bind(queries);
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const returned = vi.fn();
    vi.spyOn(queries, 'watch').mockImplementation(async (input) => {
      const feed = await original(input);
      const close = feed.return.bind(feed);
      feed.return = async () => {
        returned();
        return close();
      };
      await waiting;
      return feed;
    });
    const pending = invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request);
    const rejected = expect(pending).rejects.toThrow('document');
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    finish();
    await rejected;
    expect(returned).toHaveBeenCalledOnce();
    await dispose();
  });

  it('bounds idle subscriptions and removes handlers and pending readers on disposal', async () => {
    const { invoke, request, dispose, handlers, sender } = setup();
    const ids = [];
    for (let i = 0; i < 32; i++) ids.push(await invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request));
    await expect(invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request)).rejects.toThrow('limit');
    await invoke(TEAM_LIFECYCLE_CHANNELS.next, ids[0]);
    const pending = invoke(TEAM_LIFECYCLE_CHANNELS.next, ids[0]);
    await dispose();
    expect(await pending).toMatchObject({ done: true });
    expect(handlers.size).toBe(0);
    expect(sender.listenerCount('destroyed')).toBe(0);
    await dispose();
  });
});
