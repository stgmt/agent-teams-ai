// @vitest-environment node
import { EventEmitter } from 'node:events';

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { BOUND_CONTROL_CONTEXT_HEADER } from '../../../../src/features/external-agent-connection/contracts';
import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { registerBoundControlHttp } from '../../../../src/features/external-agent-connection/main/registerBoundControlHttp';
import { TEAM_LIFECYCLE_COMMAND_CHANNELS } from '../../../../src/features/team-provisioning/contracts';
import { registerLifecycleCommandsHttp } from '../../../../src/features/team-provisioning/main/adapters/input/registerLifecycleCommandsHttp';
import { registerLifecycleCommandsIpc } from '../../../../src/features/team-provisioning/main/adapters/input/registerLifecycleCommandsIpc';
import { createBoundLifecycleCommands } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleCommands';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';
import { createTeamLifecycleCommandBridge } from '../../../../src/features/team-provisioning/preload/createTeamLifecycleCommandBridge';

import type { MemberRuntimeEvents } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type { InvokeIpcWithResult } from '../../../../src/features/team-provisioning/preload/createTeamMemberSettingsBridge';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

// РИСК: no process is launched; these tests prove transport identity/admission, not native CLI delivery.
function setup(failBuilder = false) {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  let reads = 0;
  const starts: string[] = [];
  const lifecycle = createMemberLifecycle({
    owner,
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
    runtime: {
      spawn: (settings) => {
        starts.push(settings.memberName);
        if (failBuilder && settings.memberName === 'builder')
          return Promise.reject(new Error('TEST startup failure'));
        let events: MemberRuntimeEvents;
        return Promise.resolve({
          identity: { pid: 100 + starts.length, birthId: `TEST-birth-${starts.length}` },
          writeInput: () => Promise.resolve(),
          subscribe: (listener: typeof events) => {
            events = listener;
            listener.connected();
            return () => undefined;
          },
          stop: () => {
            events.exited({ code: 0, signal: null });
            events.released();
            return Promise.resolve();
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
    load: () => {
      reads++;
      return Promise.resolve([
        { memberName: 'team-lead', role: 'lead' as const },
        { memberName: 'builder', role: 'member' as const },
      ]);
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
  return { context, lifecycle, commands, request, starts, reads: () => reads };
}

async function httpSetup(failBuilder = false) {
  const base = setup(failBuilder);
  const server = Fastify({ logger: false });
  registerBoundControlHttp(server, base.context);
  registerLifecycleCommandsHttp(server, base.commands);
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const headers = {
    host: new URL(address).host,
    [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(base.context.snapshot()),
  };
  return { ...base, server, headers };
}

function ipcSetup(failBuilder = false) {
  const base = setup(failBuilder);
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const dispose = registerLifecycleCommandsIpc(
    ipc,
    base.commands,
    () => sender as unknown as WebContents
  );
  const invoke = async (channel: string, input: unknown, from = sender, frame = from.mainFrame) =>
    await handlers.get(channel)!(
      { sender: from, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      input
    );
  const bridge = createTeamLifecycleCommandBridge(invoke as InvokeIpcWithResult);
  return { ...base, handlers, sender, dispose, invoke, bridge };
}

describe('bound lifecycle command transports', () => {
  it('skips only an observed failed generation over HTTP and keeps the configured roster intact', async () => {
    const { server, headers, lifecycle } = await httpSetup(true);
    try {
      const launched = await server.inject({
        method: 'POST',
        url: '/api/team-runtime/test-team/launch',
        headers,
        payload: {},
      });
      const run = launched.json().run;
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );
      const request = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/skip-member',
        headers,
        payload: { runId: run.runId, memberName: 'builder', generation: 1 },
      };
      for (const payload of [
        { ...request.payload, generation: 0 },
        { ...request.payload, memberName: 'invented' },
        { ...request.payload, runId: 'TEST-old' },
      ])
        expect((await server.inject({ ...request, payload })).statusCode).toBe(409);
      expect(
        (
          await server.inject({
            ...request,
            payload: { ...request.payload, memberName: 'team-lead' },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (await server.inject({ ...request, payload: { ...request.payload, model: 'TEST-other' } }))
          .statusCode
      ).toBe(400);
      expect(
        (
          await server.inject({
            ...request,
            headers: { ...headers, origin: 'https://foreign.test' },
          })
        ).statusCode
      ).toBe(403);
      const staleHeaders = {
        ...headers,
        [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify({ ...run, connectionGeneration: 99 }),
      };
      expect((await server.inject({ ...request, headers: staleHeaders })).statusCode).toBe(409);
      expect(lifecycle.snapshot('test-team').members.builder.skippedForLaunch).toBe(false);
      const skipped = await server.inject(request);
      expect(skipped.statusCode).toBe(200);
      expect(skipped.json()).toEqual({ skipped: true });
      const before = lifecycle.snapshot('test-team');
      expect(before).toMatchObject({
        state: 'ready',
        members: {
          builder: {
            membership: 'configured',
            skippedForLaunch: true,
            error: 'TEST startup failure',
          },
        },
      });
      expect((await server.inject(request)).statusCode).toBe(200);
      expect(lifecycle.snapshot('test-team')).toEqual(before);
      await lifecycle.teams.stop(run);
      expect((await server.inject(request)).statusCode).toBe(409);
    } finally {
      await server.close();
    }
  });

  it('shares skip semantics through the plain-value preload bridge and rejects foreign IPC senders', async () => {
    const { bridge, lifecycle, request, invoke, sender, dispose, handlers, context } =
      ipcSetup(true);
    const { run } = await bridge.launchConfiguredTeam(request);
    await Promise.all(
      ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
    );
    const target = { ...request, runId: run.runId, memberName: 'builder', generation: 1 };
    await expect(
      invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.skipMember, target, { ...sender })
    ).rejects.toThrow('main renderer');
    await bridge.skipConfiguredMemberForLaunch(target);
    const before = lifecycle.snapshot('test-team');
    await bridge.skipConfiguredMemberForLaunch(target);
    expect(lifecycle.snapshot('test-team')).toEqual(before);
    expect(before.state).toBe('ready');
    await expect(
      bridge.skipConfiguredMemberForLaunch({ ...target, generation: 0 })
    ).rejects.toThrow('generation');
    const pending = bridge.skipConfiguredMemberForLaunch(target);
    context.transportReplaced();
    await expect(pending).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(lifecycle.snapshot('test-team')).toEqual(before);
    await lifecycle.teams.stop(run);
    dispose();
    expect(handlers.size).toBe(0);
  });

  it('restarts the observed generation over guarded HTTP and rejects a delayed repeat', async () => {
    const { server, headers, lifecycle, starts } = await httpSetup();
    try {
      const launched = await server.inject({
        method: 'POST',
        url: '/api/team-runtime/test-team/launch',
        headers,
        payload: {},
      });
      const run = launched.json().run;
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );
      const lead = lifecycle.snapshot('test-team').members['team-lead'];
      const command = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/restart-member',
        headers,
        payload: { runId: run.runId, memberName: 'builder', generation: 1 },
      };
      const restarted = await server.inject(command);
      expect(restarted.statusCode).toBe(200);
      expect(restarted.json()).toMatchObject({ kind: 'launch', token: { generation: 2 } });
      await lifecycle.commands.settled(run, 'builder');
      expect((await server.inject(command)).statusCode).toBe(409);
      expect(starts).toEqual(['team-lead', 'builder', 'builder']);
      expect(lifecycle.snapshot('test-team').members['team-lead']).toEqual(lead);
      await lifecycle.teams.stop(run);
    } finally {
      await server.close();
    }
  });

  it.each([
    { runId: 'TEST-old-run', memberName: 'builder', generation: 1 },
    { runId: 'TEST-run', memberName: 'invented', generation: 1 },
    { runId: 'TEST-run', memberName: 'builder', generation: 0 },
  ])(
    'rejects an obsolete or unconfigured HTTP target without stopping a member: %j',
    async (fields) => {
      const { server, headers, lifecycle, starts } = await httpSetup();
      try {
        const launched = await server.inject({
          method: 'POST',
          url: '/api/team-runtime/test-team/launch',
          headers,
          payload: {},
        });
        const run = launched.json().run;
        await Promise.all(
          ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
        );
        const before = lifecycle.snapshot('test-team');
        const payload = {
          ...fields,
          runId: fields.runId === 'TEST-run' ? run.runId : fields.runId,
        };
        const rejected = await server.inject({
          method: 'POST',
          url: '/api/team-runtime/test-team/restart-member',
          headers,
          payload,
        });
        expect(rejected.statusCode).toBe(409);
        expect(starts).toHaveLength(2);
        expect(lifecycle.snapshot('test-team')).toEqual(before);
        await lifecycle.teams.stop(run);
      } finally {
        await server.close();
      }
    }
  );

  it('applies Host/Origin, context and exact-body guards to restart before changing the process', async () => {
    const { server, headers, lifecycle, starts } = await httpSetup();
    try {
      const launched = await server.inject({
        method: 'POST',
        url: '/api/team-runtime/test-team/launch',
        headers,
        payload: {},
      });
      const run = launched.json().run;
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );
      const before = lifecycle.snapshot('test-team');
      const command = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/restart-member',
        headers,
        payload: { runId: run.runId, memberName: 'builder', generation: 1 },
      };
      expect(
        (
          await server.inject({
            ...command,
            headers: { ...headers, origin: 'https://foreign.example' },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (await server.inject({ ...command, headers: { ...headers, host: 'foreign.example' } }))
          .statusCode
      ).toBe(403);
      expect(
        (await server.inject({ ...command, headers: { host: headers.host } })).statusCode
      ).toBe(409);
      expect(
        (await server.inject({ ...command, payload: { ...command.payload, cwd: 'TEST-other' } }))
          .statusCode
      ).toBe(400);
      expect(
        (await server.inject({ ...command, payload: { ...command.payload, generation: 1.5 } }))
          .statusCode
      ).toBe(400);
      expect(
        (
          await server.inject({
            ...command,
            payload: { ...command.payload, memberName: 'team-lead' },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await server.inject({
            ...command,
            payload: { ...command.payload, memberName: '../foreign' },
          })
        ).statusCode
      ).toBe(400);
      expect(starts).toHaveLength(2);
      expect(lifecycle.snapshot('test-team')).toEqual(before);
      await lifecycle.teams.stop(run);
    } finally {
      await server.close();
    }
  });

  it('rejects another window, child frame and stale IPC restart context before termination', async () => {
    const { bridge, request, lifecycle, starts, invoke, sender, dispose } = ipcSetup();
    const foreign = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
    try {
      const { run } = await bridge.launchConfiguredTeam(request);
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );
      const target = { ...request, runId: run.runId, memberName: 'builder', generation: 1 };
      const before = lifecycle.snapshot(request.teamName);
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, target, foreign)
      ).rejects.toThrow('renderer');
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, target, sender, {})
      ).rejects.toThrow('renderer');
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, {
          ...target,
          providerId: 'anthropic',
        })
      ).rejects.toThrow();
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, {
          ...target,
          expectedContext: { ...request.expectedContext, connectionGeneration: 999 },
        })
      ).rejects.toThrow('APP_CONTEXT_MISMATCH');
      expect(lifecycle.snapshot(request.teamName)).toEqual(before);
      expect(starts).toHaveLength(2);
      await bridge.stopConfiguredTeam({ ...request, runId: run.runId });
    } finally {
      dispose();
    }
  });

  it('uses the same restart through plain preload values and current-frame IPC', async () => {
    const { bridge, request, lifecycle, starts, dispose } = ipcSetup();
    try {
      const { run } = await bridge.launchConfiguredTeam(request);
      await Promise.all(
        ['team-lead', 'builder'].map((name) => lifecycle.commands.settled(run, name))
      );
      const target = { ...request, runId: run.runId, memberName: 'builder', generation: 1 };
      await expect(bridge.restartConfiguredMember(target)).resolves.toMatchObject({
        kind: 'launch',
        token: { generation: 2 },
      });
      await lifecycle.commands.settled(run, 'builder');
      await expect(bridge.restartConfiguredMember(target)).rejects.toThrow('generation');
      expect(starts).toEqual(['team-lead', 'builder', 'builder']);
      await bridge.stopConfiguredTeam({ ...request, runId: run.runId });
    } finally {
      dispose();
    }
  });

  it('uses the same selected run through guarded HTTP launch and exact-run stop', async () => {
    const { server, headers, reads, lifecycle } = await httpSetup();
    try {
      const request = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/launch',
        headers,
        payload: {},
      };
      const [first, second] = await Promise.all([server.inject(request), server.inject(request)]);
      expect(first.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(Object.keys(first.json())).toEqual(['run']);
      expect(first.json().run).toEqual(lifecycle.snapshot('test-team').identity);
      expect(reads()).toBe(1);
      const stop = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/stop',
        headers,
        payload: { runId: first.json().run.runId },
      };
      expect((await server.inject(stop)).statusCode).toBe(200);
      expect(lifecycle.snapshot('test-team').state).toBe('stopped');
      const next = await server.inject(request);
      expect(next.json().run.runId).not.toBe(first.json().run.runId);
      const before = lifecycle.snapshot('test-team');
      expect((await server.inject(stop)).statusCode).toBe(409);
      expect(lifecycle.snapshot('test-team')).toEqual(before);
      expect(
        (await server.inject({ ...stop, payload: { runId: next.json().run.runId } })).statusCode
      ).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('rejects foreign Host/Origin, missing or stale context before canonical reads', async () => {
    const { server, headers, reads, lifecycle } = await httpSetup();
    try {
      const request = {
        method: 'POST' as const,
        url: '/api/team-runtime/test-team/launch',
        payload: {},
      };
      expect(
        (
          await server.inject({
            ...request,
            headers: { ...headers, origin: 'https://foreign.example' },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (await server.inject({ ...request, headers: { ...headers, host: 'foreign.example' } }))
          .statusCode
      ).toBe(403);
      expect(
        (await server.inject({ ...request, headers: { host: headers.host } })).statusCode
      ).toBe(409);
      expect(
        (
          await server.inject({
            ...request,
            headers: { ...headers, [BOUND_CONTROL_CONTEXT_HEADER]: 'not-json' },
          })
        ).statusCode
      ).toBe(409);
      const stale = {
        appInstanceId: 'TEST-app',
        dataRootFingerprint: 'TEST-root',
        connectionGeneration: 999,
      };
      expect(
        (
          await server.inject({
            ...request,
            headers: { ...headers, [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(stale) },
          })
        ).statusCode
      ).toBe(409);
      expect(reads()).toBe(0);
      expect(lifecycle.registry.findSnapshot('test-team')).toBeNull();
    } finally {
      await server.close();
    }
  });

  it.each([
    { url: '/api/team-runtime/test-team/launch', payload: { teamName: 'other' } },
    { url: '/api/team-runtime/test-team/launch', payload: { runId: 'TEST-chosen' } },
    { url: '/api/team-runtime/test-team/launch', payload: { providerId: 'anthropic' } },
    { url: '/api/team-runtime/test-team/launch', payload: { cwd: 'TEST-other' } },
    { url: '/api/team-runtime/test-team/launch?teamName=other', payload: {} },
    { url: '/api/team-runtime/test-team/stop', payload: {} },
    { url: '/api/team-runtime/test-team/stop', payload: { runId: 'TEST-run', teamName: 'other' } },
  ])('rejects authority-extending command values: %j', async (input) => {
    const { server, headers, reads } = await httpSetup();
    try {
      expect((await server.inject({ method: 'POST', headers, ...input })).statusCode).toBe(400);
      expect(reads()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('forwards plain command values through preload and owns exactly its IPC handlers', async () => {
    const { bridge, request, handlers, dispose, lifecycle } = ipcSetup();
    const first = await bridge.launchConfiguredTeam(request);
    expect(Object.keys(first)).toEqual(['run']);
    expect(first.run).toEqual(lifecycle.snapshot(request.teamName).identity);
    expect(await bridge.launchConfiguredTeam(request)).toEqual(first);
    await bridge.stopConfiguredTeam({ ...request, runId: first.run.runId });
    expect(lifecycle.snapshot(request.teamName).state).toBe('stopped');
    expect(handlers.size).toBe(Object.keys(TEAM_LIFECYCLE_COMMAND_CHANNELS).length);
    dispose();
    dispose();
    expect(handlers.size).toBe(0);
  });

  it('rejects another window, child frame, forged context and chosen provider before launch', async () => {
    const { invoke, request, sender, dispose, reads } = ipcSetup();
    const foreign = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
    try {
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, request, foreign)
      ).rejects.toThrow('renderer');
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, request, sender, {})
      ).rejects.toThrow('renderer');
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, { ...request, providerId: 'anthropic' })
      ).rejects.toThrow();
      await expect(
        invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, {
          ...request,
          expectedContext: { ...request.expectedContext, connectionGeneration: 999 },
        })
      ).rejects.toThrow('APP_CONTEXT_MISMATCH');
      expect(reads()).toBe(0);
    } finally {
      dispose();
    }
  });
});
