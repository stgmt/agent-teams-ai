// @vitest-environment node
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { BOUND_CONTROL_CONTEXT_HEADER } from '../../../../src/features/external-agent-connection/contracts';
import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { registerBoundControlHttp } from '../../../../src/features/external-agent-connection/main/registerBoundControlHttp';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { registerLifecycleSnapshotHttp } from '../../../../src/features/team-provisioning/main/adapters/input/registerLifecycleSnapshotHttp';
import { createBoundLifecycleQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleQueries';

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function setup() {
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
  const server = Fastify({ logger: false });
  servers.push(server);
  registerBoundControlHttp(server, context);
  registerLifecycleSnapshotHttp(server, queries);
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  const host = new URL(url).host;
  const headers = { host, [BOUND_CONTROL_CONTEXT_HEADER]: JSON.stringify(owner) };
  return { server, context, registry, queries, run, headers, url };
}

describe('guarded authoritative lifecycle HTTP snapshot', () => {
  it('returns the exact versioned source and null for a team with no in-memory run', async () => {
    const { server, registry, headers } = await setup();
    const before = registry.snapshot('test-team');
    const response = await server.inject({ url: '/api/team-runtime/test-team', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(before);
    const absent = await server.inject({ url: '/api/team-runtime/test-absent', headers });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toBeNull();
    expect(registry.snapshot('test-team')).toEqual(before);
  });

  it('shows exited, not joining, after an accepted bootstrap process exits', async () => {
    const { server, registry, run, headers } = await setup();
    const token = registry.beginTeamStart(run, () => 'TEST-operation')[1];
    const process = { pid: 101, birthId: 'TEST-birth' };
    registry.observeSpawn(token, process);
    registry.observeConnected(token);
    registry.observeExit(token, process, { code: 1, signal: null });
    const response = await server.inject({ url: '/api/team-runtime/test-team', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(registry.snapshot(run.teamName));
    expect(response.json().members.builder).toMatchObject({
      phase: 'exited',
      process: null,
      everConnected: true,
    });
  });

  it('rejects missing binding, malformed context, stale context, foreign Host and Origin', async () => {
    const { server, context, headers } = await setup();
    const url = '/api/team-runtime/test-team';
    expect((await server.inject({ url, headers: { host: headers.host } })).statusCode).toBe(409);
    expect(
      (
        await server.inject({
          url,
          headers: { ...headers, [BOUND_CONTROL_CONTEXT_HEADER]: '{' },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (await server.inject({ url, headers: { ...headers, host: 'foreign.example' } })).statusCode
    ).toBe(403);
    expect(
      (await server.inject({ url, headers: { ...headers, origin: 'https://foreign.example' } }))
        .statusCode
    ).toBe(403);
    await context.closeAdmission();
    context.rebind('TEST-next-root');
    expect((await server.inject({ url, headers })).statusCode).toBe(409);
  });

  it('rejects query fields rather than accepting an unbound team or run override', async () => {
    const { server, headers } = await setup();
    const response = await server.inject({
      url: '/api/team-runtime/test-team?runId=foreign&teamName=other',
      headers,
    });
    expect(response.statusCode).toBe(400);
  });
});
