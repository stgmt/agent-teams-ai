import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startControlServer } from '../../agent-teams-controller/test/helpers/controlServer.js';
import * as controllerModule from '../src/controller';
import { registerTools } from '../src/tools';

type RegisteredTool = {
  description?: string;
  name: string;
  parameters?: { safeParse: (value: unknown) => { success: boolean } };
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};
type RegistryRequest = { method: string; pathname: string; body: Record<string, unknown> };

function collectTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  registerTools({ addTool: (tool: RegisteredTool) => tools.set(tool.name, tool) } as never);
  return tools;
}

function parseJsonToolResult(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  return JSON.parse(text ?? '{}') as Record<string, unknown>;
}

describe('MCP task creation idempotency (registry-only)', () => {
  const tempDirs: string[] = [];
  let server: Awaited<ReturnType<typeof startControlServer>>;

  beforeEach(async () => {
    server = await startControlServer();
    vi.stubEnv('AGENT_TEAMS_BOUND_CONTROL_URL', server.url);
    vi.stubEnv(
      'AGENT_TEAMS_BOUND_CONTEXT_JSON',
      JSON.stringify({
        appInstanceId: 'mcp-idempotency-test',
        dataRootFingerprint: 'mcp-idempotency-root',
        connectionGeneration: 1,
      })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await server.stop();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTeam(teamName: string): string {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-mcp-idempotency-'));
    tempDirs.push(claudeDir);
    vi.stubEnv('AGENT_TEAMS_MCP_CLAUDE_DIR', claudeDir);
    const teamDir = path.join(claudeDir, 'teams', teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'alice', role: 'developer' },
        ],
      })
    );
    return claudeDir;
  }

  function seedMessage(claudeDir: string, teamName: string) {
    fs.writeFileSync(
      path.join(claudeDir, 'teams', teamName, 'sentMessages.json'),
      JSON.stringify([
        {
          messageId: 'msg-user-1',
          from: 'user',
          to: 'lead',
          text: 'Ship the UI and API',
          timestamp: '2026-11-05T10:00:00.000Z',
          source: 'user_sent',
        },
      ])
    );
  }

  function catalogFixture(teamName: string) {
    const original = controllerModule.getController;
    const groups = [
      { id: '00000000-0000-4000-8000-000000000001', archivedAt: null as string | null },
      { id: '11111111-1111-4111-8111-111111111111', archivedAt: null as string | null },
    ];
    let unavailable = false;
    const list = vi.fn(async (flags: Record<string, unknown>) => {
      expect(flags.from).toBe('lead');
      if (unavailable) throw new Error('Catalog unavailable');
      return groups;
    });
    vi.spyOn(controllerModule, 'getController').mockImplementation((team, dir) => {
      const controller = original(team, dir);
      controller.groupChats.listGroupChats = team === teamName ? list : async () => [];
      return controller;
    });
    return {
      groups,
      list,
      fail: () => {
        unavailable = true;
      },
    };
  }

  async function registryTasks(teamName: string) {
    const response = await fetch(`${server.url}/api/teams/${teamName}/tasks`);
    const payload = (await response.json()) as { tasks: Array<Record<string, unknown>> };
    return payload.tasks;
  }

  function expectNoTaskFiles(claudeDir: string, teamName: string) {
    const taskDir = path.join(claudeDir, 'tasks', teamName);
    expect(
      fs.existsSync(taskDir) ? fs.readdirSync(taskDir).filter((name) => name.endsWith('.json')) : []
    ).toEqual([]);
  }

  it('admits associated tasks through the catalog and replays before mutable admission checks', async () => {
    const teamName = 'associated-create';
    const claudeDir = makeTeam(teamName);
    const catalog = catalogFixture(teamName);
    const tools = collectTools();
    const create = tools.get('task_create')!;
    const request = {
      teamName,
      claudeDir,
      subject: 'Associated work',
      createdBy: 'lead',
      groupChatId: catalog.groups[0]!.id,
      idempotencyKey: 'associated-intent',
      requirements: ['FR-1'],
    };
    const first = parseJsonToolResult(await create.execute(request));
    expect(first.groupChatId).toBe(request.groupChatId);
    expect(
      parseJsonToolResult(
        await tools.get('task_get')!.execute({ teamName, claudeDir, taskId: first.id })
      ).groupChatId
    ).toBe(request.groupChatId);
    expect(
      parseJsonToolResult(await tools.get('task_list')!.execute({ teamName, claudeDir }))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, groupChatId: request.groupChatId }),
      ])
    );
    await expect(
      create.execute({ ...request, idempotencyKey: 'no-actor', createdBy: 'user' })
    ).rejects.toThrow('configured non-user');
    await expect(
      create.execute({
        ...request,
        idempotencyKey: 'foreign',
        groupChatId: '22222222-2222-4222-8222-222222222222',
      })
    ).rejects.toThrow('group in this team');
    catalog.groups[0]!.archivedAt = '2026-10-10T00:00:00.000Z';
    await expect(create.execute({ ...request, idempotencyKey: 'fresh-archived' })).rejects.toThrow(
      'archived group'
    );
    const calls = catalog.list.mock.calls.length;
    catalog.fail();
    expect(parseJsonToolResult(await collectTools().get('task_create')!.execute(request)).id).toBe(
      first.id
    );
    await expect(
      create.execute({ ...request, groupChatId: catalog.groups[1]!.id })
    ).rejects.toThrow('Task creation command conflict');
    expect(catalog.list).toHaveBeenCalledTimes(calls);
    expect(await registryTasks(teamName)).toHaveLength(1);
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('infers group context from the original user message and rejects conflicting targets and relays', async () => {
    const teamName = 'associated-message';
    const claudeDir = makeTeam(teamName);
    const catalog = catalogFixture(teamName);
    const originalId = '33333333-3333-4333-8333-333333333333';
    const original = {
      messageId: originalId,
      groupMessageId: originalId,
      groupChatId: catalog.groups[0]!.id,
      groupChatProtocolVersion: 1,
      from: 'user',
      to: 'user',
      text: 'Group request',
      timestamp: '2026-10-10T00:00:00.000Z',
      source: 'user_sent',
      read: false,
      groupRecipientNames: ['lead'],
      groupRecipientRunKeys: { lead: 'run:lead' },
    };
    const inbox = path.join(claudeDir, 'teams', teamName, 'inboxes');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'user.json'), JSON.stringify([original]));
    fs.writeFileSync(
      path.join(inbox, 'lead.json'),
      JSON.stringify([
        { ...original, messageId: 'physical-group-relay', to: 'lead', groupRunKey: 'run:lead' },
      ])
    );
    const create = collectTools().get('task_create_from_message')!;
    const request = {
      teamName,
      claudeDir,
      messageId: originalId,
      requestKey: 'group-intent',
      subject: 'Inferred association',
      createdBy: 'lead',
      requirements: ['FR-1'],
    };
    const first = parseJsonToolResult(await create.execute(request));
    expect(first.groupChatId).toBe(original.groupChatId);
    await expect(
      create.execute({
        ...request,
        requestKey: 'conflicting-source',
        groupChatId: catalog.groups[1]!.id,
      })
    ).rejects.toThrow('must agree with the original');
    await expect(
      create.execute({
        ...request,
        requestKey: 'physical-source',
        messageId: 'physical-group-relay',
      })
    ).rejects.toThrow('relay copy');
    catalog.groups[0]!.archivedAt = '2026-10-10T00:00:00.000Z';
    catalog.fail();
    expect(
      parseJsonToolResult(await collectTools().get('task_create_from_message')!.execute(request)).id
    ).toBe(first.id);
    expect(await registryTasks(teamName)).toHaveLength(1);
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('validates UUID command identities independently from numeric registry task ids', () => {
    const tools = collectTools();
    const create = tools.get('task_create')!;
    expect(create.description).toContain('Always provide a stable idempotencyKey');
    expect(tools.get('task_create_from_message')!.description).toContain(
      'Always provide a stable requestKey'
    );
    for (const commandId of ['019cce7c-f940-7777-8777-777777777777', '42']) {
      expect(
        create.parameters?.safeParse({
          teamName: 'alpha',
          subject: 'Task',
          commandId,
          requirements: ['FR-1'],
        }).success
      ).toBe(false);
    }
    expect(
      create.parameters?.safeParse({
        teamName: 'alpha',
        subject: 'Task',
        commandId: '11111111-1111-4111-8111-111111111111',
        requirements: ['FR-1'],
      }).success
    ).toBe(true);
    expect(
      create.parameters?.safeParse({
        teamName: 'alpha',
        subject: 'Task',
        idempotencyKey: '42',
        requirements: ['FR-1'],
      }).success
    ).toBe(true);
  });

  it('coalesces concurrent creates, persists provenance remotely and never selects the task id', async () => {
    const teamName = 'create-team';
    const claudeDir = makeTeam(teamName);
    const create = collectTools().get('task_create')!;
    const request = {
      teamName,
      claudeDir,
      subject: 'Create exactly once',
      owner: 'lead',
      requirements: ['FR-1'],
      commandId: '11111111-1111-4111-8111-111111111111',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };
    const [first, retry] = await Promise.all([
      create.execute(request),
      create.execute(request),
    ]).then((results) => results.map(parseJsonToolResult));
    expect(first.id).toMatch(/^\d+$/);
    expect(first.id).not.toBe(request.commandId);
    expect(first.creationCommand).toBeUndefined();
    expect(retry.id).toBe(first.id);
    expect(parseJsonToolResult(await collectTools().get('task_create')!.execute(request)).id).toBe(
      first.id
    );
    const tasks = await registryTasks(teamName);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.creationCommand).toEqual(
      expect.objectContaining({
        namespace: 'agent-teams-mcp',
        scopeKey: teamName,
        commandId: request.commandId,
        payloadHash: expect.stringMatching(/^sha256:/),
      })
    );
    await expect(create.execute({ ...request, subject: 'Changed payload' })).rejects.toThrow(
      'Task creation command conflict'
    );
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('keeps distinct message request keys separate and rejects payload reuse', async () => {
    const teamName = 'message-team';
    const claudeDir = makeTeam(teamName);
    seedMessage(claudeDir, teamName);
    const create = collectTools().get('task_create_from_message')!;
    const request = {
      teamName,
      claudeDir,
      messageId: 'msg-user-1',
      subject: 'Review the same area',
      owner: 'lead',
      requirements: ['FR-1'],
    };
    const [first, retry] = await Promise.all([
      create.execute({ ...request, requestKey: 'key-a' }),
      create.execute({ ...request, requestKey: 'key-a' }),
    ]).then((results) => results.map(parseJsonToolResult));
    const second = parseJsonToolResult(await create.execute({ ...request, requestKey: 'key-b' }));
    expect(retry.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    expect(second.subject).toBe(first.subject);
    expect(first.sourceMessageId).toBe(request.messageId);
    expect(second.sourceMessageId).toBe(request.messageId);
    await expect(
      create.execute({ ...request, requestKey: 'key-a', subject: 'Different intent' })
    ).rejects.toThrow('Task creation command conflict');
    const unkeyed = parseJsonToolResult(
      await create.execute({ ...request, subject: 'Unkeyed docs' })
    );
    const unkeyedReplay = parseJsonToolResult(
      await create.execute({ ...request, subject: 'Unkeyed docs' })
    );
    const another = parseJsonToolResult(
      await create.execute({ ...request, subject: 'Unkeyed tests' })
    );
    expect(unkeyedReplay.id).toBe(unkeyed.id);
    expect(another.id).not.toBe(unkeyed.id);
    expect(await registryTasks(teamName)).toHaveLength(4);
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('forwards normalized requirements through both create paths and rejects missing requirements', async () => {
    const teamName = 'requirements-forward';
    const claudeDir = makeTeam(teamName);
    seedMessage(claudeDir, teamName);
    const tools = collectTools();
    for (const name of ['task_create', 'task_create_from_message']) {
      const create = tools.get(name)!;
      const request = { teamName, claudeDir, messageId: 'msg-user-1', subject: name };
      const created = parseJsonToolResult(
        await create.execute({ ...request, requirements: ['FR-1', ' FR-3 ', 'FR-1'] })
      );
      expect(created.requirements).toEqual(['FR-1', 'FR-3']);
      await expect(create.execute({ ...request, subject: `${name} missing` })).rejects.toThrow(
        /requirement/i
      );
      await expect(
        create.execute({ ...request, subject: `${name} empty`, requirements: [] })
      ).rejects.toThrow(/requirement/i);
      for (const requirements of ['FR-1', ['FR-1', '  '], ['FR-1', 1]]) {
        await expect(create.execute({ ...request, requirements })).rejects.toThrow(
          'INVALID_REQUIREMENTS'
        );
        expect(create.parameters?.safeParse({ ...request, requirements }).success).toBe(false);
      }
    }
    const requests = (await server.requests()) as RegistryRequest[];
    const posts = requests.filter(
      (request) => request.method === 'POST' && request.pathname.endsWith('/tasks')
    );
    expect(
      posts.filter(
        (request) =>
          Array.isArray(request.body.requirements) && request.body.requirements.length > 0
      )
    ).toHaveLength(2);
    expect(await registryTasks(teamName)).toHaveLength(2);
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('returns APPLIED then REPLAY over HTTP while preserving advanced owner, status and relationships', async () => {
    const teamName = 'replay-advanced';
    const claudeDir = makeTeam(teamName);
    const tools = collectTools();
    const create = tools.get('task_create')!;
    const request = {
      teamName,
      claudeDir,
      subject: 'Advanced task',
      owner: 'lead',
      requirements: ['FR-1'],
      commandId: '88888888-8888-4888-8888-888888888888',
    };
    const first = parseJsonToolResult(await create.execute(request));
    const related = parseJsonToolResult(
      await create.execute({ teamName, claudeDir, subject: 'Related task', requirements: ['FR-1'] })
    );
    await tools
      .get('task_set_owner')!
      .execute({ teamName, claudeDir, taskId: first.id, owner: 'alice', actor: 'lead' });
    await tools
      .get('task_link')!
      .execute({
        teamName,
        claudeDir,
        taskId: first.id,
        targetId: related.id,
        relationship: 'related',
      });
    await tools
      .get('task_set_status')!
      .execute({ teamName, claudeDir, taskId: first.id, status: 'in_progress', actor: 'alice' });
    const replayed = parseJsonToolResult(await create.execute(request));
    expect(replayed).toMatchObject({
      id: first.id,
      owner: 'alice',
      status: 'in_progress',
      related: expect.arrayContaining([related.id]),
    });
    const stored = (await registryTasks(teamName)).find((task) => task.id === first.id)!;
    const response = await fetch(`${server.url}/api/teams/${teamName}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: request.subject,
        requirements: request.requirements,
        owner: request.owner,
        creationCommand: stored.creationCommand,
      }),
    });
    expect(await response.json()).toMatchObject({
      outcome: 'REPLAY',
      task: { id: first.id, owner: 'alice', status: 'in_progress' },
    });
    expectNoTaskFiles(claudeDir, teamName);
  });

  it('does not adopt a local task when the registry is available', async () => {
    const teamName = 'no-file-adoption';
    const claudeDir = makeTeam(teamName);
    const taskDir = path.join(claudeDir, 'tasks', teamName);
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, '42.json');
    const original = JSON.stringify({ id: '42', subject: 'Local task', status: 'pending' });
    fs.writeFileSync(taskFile, original);
    const tools = collectTools();
    await expect(
      tools.get('task_get')!.execute({ teamName, claudeDir, taskId: '42' })
    ).rejects.toThrow();
    const created = parseJsonToolResult(
      await tools.get('task_create')!.execute({
        teamName,
        claudeDir,
        subject: 'Registry task',
        requirements: ['FR-1'],
        commandId: '22222222-2222-4222-8222-222222222222',
      })
    );
    expect(created.id).not.toBe('42');
    expect(await registryTasks(teamName)).toHaveLength(1);
    expect(fs.readFileSync(taskFile, 'utf8')).toBe(original);
  });

  it('does not read or mutate canonical task files when registry access fails', async () => {
    const teamName = 'no-file-fallback';
    const claudeDir = makeTeam(teamName);
    const taskDir = path.join(claudeDir, 'tasks', teamName);
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, '42.json');
    const localTask = JSON.stringify({ id: '42', subject: 'Must not be read', status: 'pending' });
    fs.writeFileSync(taskFile, localTask);
    await server.stop();
    server = await startControlServer({ failStatus: 503 });
    vi.stubEnv('AGENT_TEAMS_BOUND_CONTROL_URL', server.url);
    const tools = collectTools();
    await expect(
      tools.get('task_get')!.execute({ teamName, claudeDir, taskId: '42' })
    ).rejects.toThrow();
    await expect(
      tools
        .get('task_create')!
        .execute({ teamName, claudeDir, subject: 'Must fail closed', requirements: ['FR-1'] })
    ).rejects.toThrow();
    expect(fs.readFileSync(taskFile, 'utf8')).toBe(localTask);
    expect(fs.readdirSync(taskDir)).toEqual(['42.json']);
  });
});
