// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BoundControlContext,
  registerBoundControlHttp,
} from '../../../src/features/external-agent-connection/main';
import {
  createNodeLeadReporting,
  registerLeadReportingHttp,
} from '../../../src/features/lead-reporting/main';
import { MemberLifecycleRegistry } from '../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import {
  completeLeadTurn,
  confirmDeliveredUserReply,
  recordLeadTurnText,
  registerDirectUserRequest,
} from '../../../src/main/services/team/provisioning/TeamProvisioningLeadUserReplyTracker';
import { TeamMembersMetaStore } from '../../../src/main/services/team/TeamMembersMetaStore';

import type { TeamTask } from '../../../src/shared/types';

const require = createRequire(import.meta.url);
const controllerPath = require.resolve('../../../agent-teams-controller/src/controller.js');
const bindingPath =
  require.resolve('../../../agent-teams-controller/src/internal/desktopControlBinding.js');
const clientPath =
  require.resolve('../../../agent-teams-controller/src/internal/leadReportingClient.js');
const taskBoardPath = require.resolve('../../../agent-teams-controller/src/internal/taskBoard.js');
const messagesPath = require.resolve('../../../agent-teams-controller/src/internal/messages.js');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const path of [controllerPath, bindingPath, clientPath, taskBoardPath, messagesPath])
    delete require.cache[path];
});

async function setup(text = 'как там дела?', changed = vi.fn()) {
  const profile = await mkdtemp(join(tmpdir(), 'test-lead-report-'));
  cleanups.push(() =>
    rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  );
  const teamName = 'test-report-team';
  const teamsRoot = join(profile, 'teams');
  const team = join(teamsRoot, teamName);
  const tasks = join(profile, 'tasks', teamName);
  await mkdir(team, { recursive: true });
  await mkdir(tasks, { recursive: true });
  const members = [
    { name: 'team-lead', agentType: 'team-lead' },
    { name: 'worker' },
    { name: 'free' },
  ];
  await writeFile(join(team, 'members.meta.json'), JSON.stringify({ version: 1, members }));
  await writeFile(join(team, 'config.json'), JSON.stringify({ name: teamName, members }));
  const taskId = '12345678-1234-4234-8234-123456789abc';
  // One canonical task: the app-side adapter receives it as a registry-owned snapshot,
  // and the same task is persisted for the isolated controller's own reads.
  const task: TeamTask = {
    id: taskId,
    subject: 'Checkout is blocked on review',
    owner: 'worker',
    status: 'in_progress',
    needsClarification: 'lead',
    comments: [
      {
        id: 'test-comment',
        author: 'worker',
        text: 'I finished everything',
        createdAt: '2026-10-29T00:00:00Z',
        type: 'regular',
      },
    ],
  };
  await writeFile(join(tasks, `${taskId}.json`), JSON.stringify(task));
  const context = new BoundControlContext('test-app', profile);
  const run = { ...context.snapshot(), teamName, runId: 'test-run' };
  const registry = new MemberLifecycleRegistry(run);
  registry.configureTeam(
    run,
    members.map((member) => ({
      memberName: member.name,
      role: member.name === 'team-lead' ? 'lead' : 'member',
    }))
  );
  const tracker = {};
  registerDirectUserRequest(tracker, 'test-request');
  recordLeadTurnText(tracker, 'I will check everyone now.');
  const feature = createNodeLeadReporting({
    teamsRoot,
    members: new TeamMembersMetaStore(),
    resolveLead: (credential) => {
      if (credential !== 'test-secret') throw new Error('Unauthorized');
      context.assertExpected(run);
      return run;
    },
    lifecycle: () => Promise.resolve(registry.snapshot(teamName)),
    tasks: () => Promise.resolve([task]),
    taskChanges: () => Promise.resolve(null),
    leadName: () => Promise.resolve('team-lead'),
    changed,
    delivered: (_run, report) => confirmDeliveredUserReply(tracker, [report.requestMessageId]),
  });
  await feature.acceptHumanRequest({
    run,
    requestMessageId: 'test-request',
    text,
    origin: { kind: 'human' },
    isMeta: false,
  });
  const server = Fastify({ logger: false });
  cleanups.push(() => server.close());
  registerBoundControlHttp(server, context);
  registerLeadReportingHttp(server, feature);
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  // Only the isolated MCP controller receives the bound child environment. The app-side adapter is already constructed.
  vi.stubEnv('AGENT_TEAMS_BOUND_CONTROL_URL', url);
  vi.stubEnv('AGENT_TEAMS_BOUND_CONTEXT_JSON', JSON.stringify(run));
  vi.stubEnv('AGENT_TEAMS_MCP_CLAUDE_DIR', profile);
  vi.stubEnv('AGENT_TEAMS_LEAD_START_CREDENTIAL', 'test-secret');
  for (const path of [controllerPath, bindingPath, clientPath, taskBoardPath, messagesPath])
    delete require.cache[path];
  const { createController } = require(controllerPath);
  const controller = createController({
    teamName,
    claudeDir: profile,
    allowUserMessageSender: false,
  });
  return { controller, feature, team, tasks, taskId, tracker, server, run, url, context };
}

describe('app/controller lead-report delivery on an isolated profile', () => {
  it('retries projection notification after the inbox append without reopening or rewriting the reply', async () => {
    const changed = vi.fn().mockImplementationOnce(() => {
      throw new Error('test-projection');
    });
    const { controller, team, feature, run } = await setup('спасибо', changed);
    const message = {
      from: 'team-lead',
      to: 'user',
      text: 'Пожалуйста.',
      requestMessageId: 'test-request',
    };
    await expect(controller.messages.sendMessage(message)).rejects.toThrow('test-projection');
    const before = await readFile(join(team, 'inboxes', 'user.json'), 'utf8');
    await expect(
      feature.acceptHumanRequest({
        run,
        requestMessageId: 'next-request',
        text: 'спасибо',
        origin: { kind: 'human' },
        isMeta: false,
      })
    ).rejects.toThrow('active');
    await controller.messages.sendMessage(message);
    expect(await readFile(join(team, 'inboxes', 'user.json'), 'utf8')).toBe(before);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('persists a bounded roster-failure reply and closes only its exact human request', async () => {
    const { feature, team, run, tracker } = await setup('спасибо');
    await feature.reply('test-secret', 'test-request', 'Пожалуйста.');
    registerDirectUserRequest(tracker, 'failed-roster-request');
    await writeFile(join(team, 'members.meta.json'), '{invalid-json');
    const input = {
      run,
      requestMessageId: 'failed-roster-request',
      text: 'как там дела?',
      origin: { kind: 'human' as const },
      isMeta: false as const,
    };
    const instruction = await feature.acceptHumanRequest(input);
    expect(instruction).toContain('already delivered');
    const rows = JSON.parse(await readFile(join(team, 'inboxes', 'user.json'), 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      replyToMessageIds: ['failed-roster-request'],
      replyChannel: 'explicit',
      leadSessionId: run.runId,
    });
    expect(rows[1].text).toContain('saved team roster could not be read');
    expect(rows[1].text).toContain('Canonical saved roster is unavailable');
    expect(await feature.acceptHumanRequest(input)).toBe(instruction);
    expect(JSON.parse(await readFile(join(team, 'inboxes', 'user.json'), 'utf8'))).toHaveLength(2);
    expect(
      completeLeadTurn(tracker, { leadName: 'team-lead', runId: run.runId, nowIso: '', nowMs: 1 })
        .fallbackReply
    ).toBeNull();
    expect(feature.reports.current('test-secret')).toBeNull();
  });

  it('redacts and bounds delivery diagnostics before returning them through HTTP', async () => {
    const changed = vi.fn().mockImplementationOnce(() => {
      throw new Error(`projection failed API_TOKEN=test-only-secret-value ${'x'.repeat(800)}`);
    });
    const { server, url, run } = await setup('спасибо', changed);
    const response = await server.inject({
      method: 'POST',
      url: '/api/lead-reporting/reply',
      headers: {
        host: new URL(url).host,
        authorization: 'Bearer test-secret',
        'x-agent-teams-app-context': JSON.stringify(run),
      },
      payload: { requestMessageId: 'test-request', text: 'Пожалуйста.' },
    });
    expect(response.statusCode).toBe(409);
    const error = response.json<{ error: string }>().error;
    expect(error).toContain('projection failed');
    expect(error).not.toContain('test-only-secret-value');
    expect(error.length).toBeLessThanOrEqual(500);
  });

  it('delivers an ordinary answer without inspection and rejects a stale request identity', async () => {
    const { controller, team, tracker, feature, run } = await setup('спасибо');
    const sent = {
      from: 'team-lead',
      to: 'user',
      text: 'Пожалуйста.',
      requestMessageId: 'test-request',
    };
    await expect(
      controller.messages.sendMessage({ ...sent, requestMessageId: 'wrong' })
    ).rejects.toThrow('matching');
    const result = await controller.messages.sendMessage(sent);
    expect(await controller.messages.sendMessage(sent)).toMatchObject({
      messageId: result.messageId,
    });
    await feature.acceptHumanRequest({
      run,
      requestMessageId: 'next-request',
      text: 'спасибо',
      origin: { kind: 'human' },
      isMeta: false,
    });
    await expect(controller.messages.sendMessage(sent)).rejects.toThrow('matching');
    const rows = JSON.parse(await readFile(join(team, 'inboxes', 'user.json'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: 'Пожалуйста.', replyToMessageIds: ['test-request'] });
    expect(
      completeLeadTurn(tracker, { leadName: 'team-lead', runId: 'test-run', nowIso: '', nowMs: 1 })
        .fallbackReply
    ).toBeNull();
  });

  it('allows management-only briefing without inventing a human report operation or a publication receipt', async () => {
    const { controller, feature, run, team } = await setup('спасибо');
    await controller.messages.sendMessage({
      from: 'team-lead',
      to: 'user',
      text: 'Пожалуйста.',
      requestMessageId: 'test-request',
    });
    const before = await readFile(join(team, 'inboxes', 'user.json'), 'utf8');
    const briefing = JSON.parse(await controller.taskBoard.leadBriefing());
    expect(briefing.kind).toBe('management');
    expect(briefing.inspection.run).toEqual(run);
    expect(briefing.inspection.members.map((member: { name: string }) => member.name)).toEqual([
      'free',
      'worker',
    ]);
    expect(briefing.inspection.inspectionId).toBeUndefined();
    expect(briefing.inspection.reportRunId).toBeUndefined();
    expect(briefing.instruction).toContain('not a new human report request');
    expect(feature.reports.current('test-secret')).toBeNull();
    await expect(
      feature.reports.publish('test-secret', {
        inspectionId: 'made-up-management-receipt',
        summary: 'test',
        members: [],
        nextStep: 'test',
      })
    ).rejects.toThrow('receipt');
    expect(await readFile(join(team, 'inboxes', 'user.json'), 'utf8')).toBe(before);
  });

  it('bounds failed report corrections with one durable exact-request limitation and no work-log duplicate', async () => {
    const { controller, feature, team, run, tracker } = await setup();
    const { inspection } = JSON.parse(await controller.taskBoard.leadBriefing());
    const message = {
      from: 'team-lead',
      to: 'user',
      text: 'An unchecked report.',
      report: {
        inspectionId: inspection.inspectionId,
        summary: 'An unchecked report.',
        members: [],
        nextStep: 'Review the missing facts.',
      },
    };
    for (let index = 0; index < 4; index++)
      await expect(controller.messages.sendMessage(message)).rejects.toThrow('coverage');
    await expect(controller.messages.sendMessage(message)).rejects.toThrow(
      'limitation was already delivered'
    );
    const before = await readFile(join(team, 'inboxes', 'user.json'), 'utf8');
    const rows = JSON.parse(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      replyToMessageIds: ['test-request'],
      replyChannel: 'explicit',
      leadSessionId: run.runId,
    });
    expect(rows[0].text).toContain('publication correction limit');
    expect(rows[0].text).not.toContain(message.text);
    await expect(controller.messages.sendMessage(message)).rejects.toThrow(
      'limitation was already delivered'
    );
    expect(await readFile(join(team, 'inboxes', 'user.json'), 'utf8')).toBe(before);
    expect(
      completeLeadTurn(tracker, { leadName: 'team-lead', runId: run.runId, nowIso: '', nowMs: 1 })
        .fallbackReply
    ).toBeNull();
    await expect(
      feature.acceptHumanRequest({
        run,
        requestMessageId: 'next-request',
        text: 'спасибо',
        origin: { kind: 'human' },
        isMeta: false,
      })
    ).resolves.toContain('next-request');
  });

  it('keeps Host/Origin/context admission and rejects malformed inspection overrides', async () => {
    const { server, url, run, context } = await setup();
    const host = new URL(url).host;
    const headers = {
      host,
      authorization: 'Bearer test-secret',
      'x-agent-teams-app-context': JSON.stringify(run),
    };
    for (const payload of [[], null, 'override', { scope: 'team' }]) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/lead-reporting/inspect',
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(response.statusCode).toBe(400);
    }
    const post = (extra: Record<string, string>) =>
      server.inject({
        method: 'POST',
        url: '/api/lead-reporting/inspect',
        headers: { ...headers, 'content-type': 'application/json', ...extra },
        payload: {},
      });
    expect((await post({ host: 'foreign.example' })).statusCode).toBe(403);
    expect((await post({ origin: 'https://foreign.example' })).statusCode).toBe(403);
    expect((await post({ authorization: 'Bearer wrong' })).statusCode).toBe(403);
    context.transportReplaced();
    expect((await post({})).statusCode).toBe(409);
  });

  it('persists a report with real task evidence, not the earlier acknowledgement or a claimed completion', async () => {
    const { controller, team, tracker, feature, run } = await setup();
    const { inspection } = JSON.parse(await controller.taskBoard.leadBriefing());
    expect(inspection.members.map((member: { name: string }) => member.name)).toEqual([
      'free',
      'worker',
    ]);
    const worker = inspection.members.find((member: { name: string }) => member.name === 'worker');
    expect(worker.reportedResults[0].verification).toBe('reported');
    expect(worker.verifiedResults).toEqual([]);
    const report = {
      inspectionId: inspection.inspectionId,
      summary: 'Checkout remains unfinished; review is blocked.',
      nextStep: 'Resolve the review clarification.',
      members: inspection.members.map(
        (member: { name: string; tasks: { evidence: { evidenceId: string }[] }[] }) => ({
          memberName: member.name,
          statements: [
            {
              kind: 'observation',
              text:
                member.name === 'worker'
                  ? 'worker has an unfinished checkout task and needs lead clarification.'
                  : 'free has no assigned tasks.',
              evidenceIds: [member.tasks[0]?.evidence[0]?.evidenceId ?? `process:${member.name}`],
            },
          ],
        })
      ),
    };
    const result = await controller.messages.sendMessage({
      from: 'team-lead',
      to: 'user',
      text: report.summary,
      report,
    });
    expect(result.requestMessageId).toBe('test-request');
    const rows = JSON.parse(await readFile(join(team, 'inboxes', 'user.json'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      replyToMessageIds: ['test-request'],
      replyChannel: 'explicit',
    });
    expect(rows[0].text).toContain('unfinished checkout task');
    expect(rows[0].text).not.toContain('I finished everything');
    expect(rows[0].text).toContain('Facts observed:');
    expect(rows[0].text).toContain('worker [member claim]');
    expect(rows[0].text).toContain('free [board fact]');
    await expect(
      feature.acceptHumanRequest({
        run,
        requestMessageId: 'next-human',
        text: 'спасибо',
        origin: { kind: 'human' },
        isMeta: false,
      })
    ).resolves.toContain('next-human');
    expect(
      completeLeadTurn(tracker, { leadName: 'team-lead', runId: 'test-run', nowIso: '', nowMs: 1 })
        .fallbackReply
    ).toBeNull();
  });

  it('writes no user row when the MCP caller omits evidence or publication fails', async () => {
    const { controller, team, server } = await setup();
    expect(() =>
      controller.messages.sendMessage({
        from: 'team-lead',
        to: 'user',
        text: 'Everyone is running',
      })
    ).toThrow('require');
    await expect(
      controller.messages.sendMessage({
        from: 'team-lead',
        to: 'user',
        text: 'Everyone is running',
        requestMessageId: 'test-request',
      })
    ).rejects.toThrow('inspected report');
    await expect(readFile(join(team, 'inboxes', 'user.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const { inspection } = JSON.parse(await controller.taskBoard.leadBriefing());
    await server.close();
    await expect(
      controller.messages.sendMessage({
        from: 'team-lead',
        to: 'user',
        text: 'test',
        report: { summary: 'test', inspectionId: inspection.inspectionId },
      })
    ).rejects.toThrow();
    await expect(readFile(join(team, 'inboxes', 'user.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
