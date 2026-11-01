// @vitest-environment node
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { BOUND_CONTROL_CONTEXT_HEADER } from '../../../../src/features/external-agent-connection/contracts';
import {
  AppContextMismatchError,
  BoundControlContext,
} from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { registerBoundControlHttp } from '../../../../src/features/external-agent-connection/main/registerBoundControlHttp';
import { registerMemberLifecycleHttp } from '../../../../src/features/team-provisioning/main/adapters/input/registerMemberLifecycleHttp';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

const owner = { appInstanceId: 'app', dataRootFingerprint: 'root', connectionGeneration: 1 };
const run = { ...owner, teamName: 'TEST-team', runId: 'run' };
const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function setup(boundOwner = owner) {
  const boundRun = { ...run, ...boundOwner };
  const starts: string[] = [];
  const lifecycle = createMemberLifecycle({
    owner: boundOwner,
    settings: {
      async findConfiguredMember(team, memberName) {
        return {
          team,
          memberName,
          configurationRevision: 'revision',
          providerId: 'TEST',
          model: null,
          workingDirectory: 'TEST',
          instructions: 'TEST',
        };
      },
    },
    runtime: {
      async spawn(settings) {
        starts.push(settings.memberName);
        return {
          identity: { pid: 123, birthId: 'birth' },
          subscribe: () => () => undefined,
          stop: async () => undefined,
          writeInput: async () => undefined,
        };
      },
    },
  });
  lifecycle.registry.configureTeam(boundRun, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
  ]);
  const credential = lifecycle.bindLead(boundRun);
  const server = Fastify({ logger: false });
  servers.push(server);
  registerMemberLifecycleHttp(server, lifecycle.leadStart);
  return { server, credential, lifecycle, starts };
}

describe('bound lead member-start HTTP route', () => {
  it('preserves a context mismatch as 409 instead of misreporting malformed member input', async () => {
    const server = Fastify({ logger: false });
    servers.push(server);
    registerMemberLifecycleHttp(server, {
      async execute() {
        throw new AppContextMismatchError();
      },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/team-runtime/member-start',
      headers: { authorization: 'Bearer TEST-scoped-credential' },
      payload: { memberName: 'builder' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('APP_CONTEXT_MISMATCH');
  });

  it('runs behind the desktop Host/Origin and bound-context guard without admitting rejected starts', async () => {
    const context = new BoundControlContext('TEST-guard-app', 'TEST-guard-root');
    const { lifecycle, credential, starts } = setup(context.snapshot());
    const server = Fastify({ logger: false });
    servers.push(server);
    registerBoundControlHttp(server, context);
    registerMemberLifecycleHttp(server, lifecycle.leadStart);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const headers = {
      host: new URL(address).host,
      authorization: `Bearer ${credential}`,
      [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(context.snapshot()),
    };
    const request = {
      method: 'POST' as const,
      url: '/api/team-runtime/member-start',
      payload: { memberName: 'builder' },
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
    const stale = { ...context.snapshot(), connectionGeneration: 999 };
    expect(
      (
        await server.inject({
          ...request,
          headers: { ...headers, [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(stale) },
        })
      ).statusCode
    ).toBe(409);
    expect(starts).toEqual([]);
    expect((await server.inject({ ...request, headers })).statusCode).toBe(200);
    expect(starts).toEqual(['builder']);
  });

  it('starts only the configured own-team member and coalesces HTTP duplicates', async () => {
    const { server, credential, starts } = setup();
    const request = {
      method: 'POST' as const,
      url: '/api/team-runtime/member-start',
      headers: { authorization: `Bearer ${credential}` },
      payload: { memberName: 'builder' },
    };
    const [first, second] = await Promise.all([server.inject(request), server.inject(request)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect([first.json().kind, second.json().kind]).toEqual(['launch', 'pending']);
    expect(starts).toEqual(['builder']);
  });

  it('rejects missing, forged, revoked credentials and cross-team fields', async () => {
    const { server, credential, lifecycle, starts } = setup();
    const request = {
      method: 'POST' as const,
      url: '/api/team-runtime/member-start',
      payload: { memberName: 'builder' },
    };
    expect((await server.inject(request)).statusCode).toBe(401);
    expect(
      (await server.inject({ ...request, headers: { authorization: 'Bearer team-lead' } }))
        .statusCode
    ).toBe(403);
    expect(
      (
        await server.inject({
          ...request,
          headers: { authorization: `Bearer ${credential}` },
          payload: { memberName: 'builder', teamName: 'other' },
        })
      ).statusCode
    ).toBe(400);
    lifecycle.revokeLead(run);
    expect(
      (await server.inject({ ...request, headers: { authorization: `Bearer ${credential}` } }))
        .statusCode
    ).toBe(403);
    expect(starts).toEqual([]);
  });
});
