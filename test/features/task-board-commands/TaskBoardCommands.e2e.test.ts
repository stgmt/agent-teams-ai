// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { RegistryTaskProviderError } from '@main/services/team/registry/RegistryTaskProvider';
import { RegistryTeamTaskWriteError } from '@main/services/team/registry/RegistryTeamTaskWriter';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { getLocalTasksBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRegistryLiveFixture,
  type RegistryLiveFixture,
} from '../../main/services/team/helpers/registryLiveFixture';

import type { TeamGroupChatDTO } from '@features/team-group-chats/contracts';
import type { CreateTaskRequest } from '@shared/types';

const TEAM_NAME = 'task-command-registry-e2e';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const REQUIREMENTS = ['FR-1', 'AC-1.1'];

interface TaskBoardHarness {
  claudeDir: string;
  service: TeamDataService;
}

let tempDir: string | null = null;
let registryFixture: RegistryLiveFixture | null = null;

afterEach(async () => {
  const activeFixture = registryFixture;
  registryFixture = null;
  try {
    await activeFixture?.dispose();
  } finally {
    setClaudeBasePathOverride(null);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      tempDir = null;
    }
  }
});

const realRegistry = process.env.AGENT_TEAMS_TEST_REGISTRY_SOURCE ? describe : describe.skip;
realRegistry('task-board commands E2E', () => {
  it('creates and replays through the registry without reading legacy canonical task files', async () => {
    const harness = await makeHarness();
    const legacyTaskPath = path.join(harness.claudeDir, 'tasks', TEAM_NAME, '999.json');
    const legacyTask = JSON.stringify({ id: '999', subject: 'Obsolete local task', status: 'pending' });
    await fs.mkdir(path.dirname(legacyTaskPath), { recursive: true });
    await fs.writeFile(legacyTaskPath, legacyTask);

    expect(await harness.service.getTasks(TEAM_NAME)).toEqual([]);

    const request: CreateTaskRequest = {
      command: makeCommand('11111111-1111-4111-8111-111111111111'),
      subject: 'One registry task',
      description: 'Created through the task board boundary.',
      requirements: REQUIREMENTS,
    };
    const first = await harness.service.createTaskWithOutcome(TEAM_NAME, request);
    const replay = await harness.service.createTaskWithOutcome(TEAM_NAME, request);

    expect(first.outcome).toBe('APPLIED');
    expect(first.task).toMatchObject({
      id: '1',
      displayId: '1',
      subject: 'One registry task',
      description: 'Created through the task board boundary.',
      status: 'pending',
    });
    expect(replay.outcome).toBe('REPLAY');
    expect(replay.task.id).toBe(first.task.id);

    await expect(
      harness.service.createTaskWithOutcome(TEAM_NAME, {
        ...request,
        subject: 'Conflicting command payload',
      })
    ).rejects.toMatchObject({
      name: 'RegistryTeamTaskWriteError',
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const registryTasks = await harness.service.getTasks(TEAM_NAME);
    expect(registryTasks).toHaveLength(1);
    expect(registryTasks[0]).toMatchObject({
      id: first.task.id,
      subject: 'One registry task',
      createdAt: first.task.createdAt,
      description: 'Created through the task board boundary.',
    });
    expect(registryTasks[0]).not.toHaveProperty('creationCommand');
    expect(await fs.readFile(legacyTaskPath, 'utf8')).toBe(legacyTask);
    await expect(
      fs.access(path.join(harness.claudeDir, 'tasks', TEAM_NAME, `${first.task.id}.json`))
    ).rejects.toThrow();
  });

  it('edits canonical fields and records owner and lifecycle transitions in registry', async () => {
    const harness = await makeHarness();
    const created = await harness.service.createTask(TEAM_NAME, taskRequest('Before edit'));

    await harness.service.updateTaskFields(TEAM_NAME, created.id, {
      subject: 'Edited registry title',
      description: 'Edited registry description.',
    });
    await harness.service.updateTaskOwner(TEAM_NAME, created.id, 'worker', 'lead');

    const startReceipt = await harness.service.updateTaskStatusWithReceipt(
      TEAM_NAME,
      created.id,
      'in_progress',
      'worker',
      'pending'
    );
    expect(startReceipt).toContainEqual(
      expect.objectContaining({ localId: `TASK-${created.id}`, from: 'todo', to: 'in-progress' })
    );

    await expect(
      harness.service.updateTaskStatusWithReceipt(
        TEAM_NAME,
        created.id,
        'completed',
        'worker',
        'pending'
      )
    ).rejects.toMatchObject({
      name: 'RegistryTeamTaskWriteError',
      code: 'STATUS_CONFLICT',
    });

    await harness.service.updateTaskStatusWithReceipt(
      TEAM_NAME,
      created.id,
      'completed',
      'worker',
      'in_progress'
    );
    const updated = (await harness.service.getTasks(TEAM_NAME))[0];
    expect(updated).toMatchObject({
      id: created.id,
      subject: 'Edited registry title',
      description: 'Edited registry description.',
      owner: 'worker',
      status: 'completed',
    });
  });

  it('persists comments in isolated execution metadata and merges them into registry task reads', async () => {
    const harness = await makeHarness();
    const created = await harness.service.createTask(TEAM_NAME, taskRequest('Commented task'));

    const comment = await harness.service.addTaskComment(
      TEAM_NAME,
      created.id,
      'The registry-backed task is ready for review.'
    );
    const reloaded = await harness.service.getTask(TEAM_NAME, created.id);
    expect(comment).toMatchObject({ author: 'user', text: 'The registry-backed task is ready for review.' });
    expect(reloaded?.comments).toContainEqual(expect.objectContaining({ id: comment.id, text: comment.text }));

    const executionPath = path.join(getLocalTasksBasePath(), TEAM_NAME, `${created.id}.json`);
    const executionRecord = JSON.parse(await fs.readFile(executionPath, 'utf8')) as Record<string, unknown>;
    expect(executionRecord).toMatchObject({
      taskId: created.id,
      comments: [expect.objectContaining({ id: comment.id, text: comment.text })],
    });
    expect(executionRecord).not.toHaveProperty('subject');
    expect(executionRecord).not.toHaveProperty('status');
    expect(executionRecord).not.toHaveProperty('owner');
  });

  it('preserves group-chat admission and edits against the registry-backed task', async () => {
    const harness = await makeHarness();
    const group: TeamGroupChatDTO = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Task context',
      createdAt: '2026-10-10T12:00:00.000Z',
      membership: { kind: 'fixed', memberNames: ['lead', 'worker'] },
      memberNames: ['lead', 'worker'],
      availableRecipientNames: [],
      canSend: false,
      archivedAt: null,
    };
    const catalog = vi.fn(async () => [group]);
    harness.service.setTaskGroupChatCatalog(catalog);
    const request: CreateTaskRequest = {
      command: makeCommand('abababab-abab-4bab-8bab-abababababab'),
      subject: 'Associated registry task',
      requirements: REQUIREMENTS,
      groupChatId: group.id,
    };
    const created = await harness.service.createTask(TEAM_NAME, request);
    expect((await harness.service.getTask(TEAM_NAME, created.id))?.groupChatId).toBe(group.id);
    expect(catalog).toHaveBeenCalledExactlyOnceWith(TEAM_NAME);

    group.archivedAt = '2026-10-10T12:01:00.000Z';
    catalog.mockClear();
    expect((await harness.service.createTask(TEAM_NAME, request)).id).toBe(created.id);
    expect(catalog).not.toHaveBeenCalled();
    await expect(
      harness.service.createTask(TEAM_NAME, {
        subject: 'Archived destination',
        requirements: REQUIREMENTS,
        groupChatId: group.id,
      })
    ).rejects.toThrow('archived group chat');
    await expect(
      harness.service.createTask(TEAM_NAME, {
        subject: 'Foreign destination',
        requirements: REQUIREMENTS,
        groupChatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })
    ).rejects.toThrow('does not belong to this team');
    await expect(
      harness.service.createTask(TEAM_NAME, {
        subject: 'Malformed destination',
        requirements: REQUIREMENTS,
        groupChatId: 'not-a-uuid',
      })
    ).rejects.toThrow('UUID');
    catalog.mockClear();

    catalog.mockRejectedValue(new Error('Catalog is unavailable'));
    await harness.service.updateTaskFields(TEAM_NAME, created.id, { subject: 'Edited associated task' });
    await harness.service.updateTaskFields(TEAM_NAME, created.id, { groupChatId: group.id });
    expect((await harness.service.getTask(TEAM_NAME, created.id))?.groupChatId).toBe(group.id);
    await harness.service.updateTaskFields(TEAM_NAME, created.id, { groupChatId: null });
    expect(await harness.service.getTask(TEAM_NAME, created.id)).not.toHaveProperty('groupChatId');
    expect(catalog).not.toHaveBeenCalled();
    expect(await harness.service.getTasks(TEAM_NAME)).toHaveLength(1);
  });

  it('rejects task creation without requirement references', async () => {
    const harness = await makeHarness();

    await expect(
      harness.service.createTask(TEAM_NAME, { subject: 'No registry requirements', requirements: [] })
    ).rejects.toMatchObject({
      name: 'RegistryTeamTaskWriteError',
      code: 'REQUIREMENTS_REQUIRED',
    });
    expect(await harness.service.getTasks(TEAM_NAME)).toEqual([]);
  });

  it('fails closed without a registry binding instead of consulting local task files', async () => {
    const harness = await makeHarness({ bound: false });
    const legacyTaskPath = path.join(harness.claudeDir, 'tasks', TEAM_NAME, '1.json');
    await fs.mkdir(path.dirname(legacyTaskPath), { recursive: true });
    await fs.writeFile(legacyTaskPath, JSON.stringify({ id: '1', subject: 'Must not be read' }));

    await expect(harness.service.getTasks(TEAM_NAME)).rejects.toMatchObject({
      name: 'RegistryTaskProviderError',
      code: 'REGISTRY_SCOPE_INCOMPLETE',
      causeCode: 'SPEC_PROJECT_MISSING',
    });
    await expect(
      harness.service.createTask(TEAM_NAME, taskRequest('Unbound task'))
    ).rejects.toMatchObject({
      name: 'TeamSpecBindingError',
      code: 'SPEC_PROJECT_MISSING',
    });
    expect(await fs.readFile(legacyTaskPath, 'utf8')).toContain('Must not be read');
  });
});

async function makeHarness(options: { bound?: boolean } = {}): Promise<TaskBoardHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-registry-e2e-'));
  tempDir = root;
  const claudeDir = path.join(root, 'claude');
  await fs.mkdir(claudeDir, { recursive: true });
  setClaudeBasePathOverride(claudeDir);
  const fixture = await createRegistryLiveFixture(root);
  registryFixture = fixture;

  const config = {
    name: TEAM_NAME,
    leadSessionId: 'test-lead-session',
    members: [{ name: 'lead', role: 'team-lead' }, { name: 'worker', role: 'worker' }],
    ...(options.bound === false
      ? {}
      : { specProject: fixture.binding.project, specSlug: fixture.binding.spec }),
  };
  const configReader = {
    getConfig: async (teamName: string) => (teamName === TEAM_NAME ? config : null),
    getConfigSnapshot: async (teamName: string) => (teamName === TEAM_NAME ? config : null),
  };
  return { claudeDir, service: new TeamDataService(configReader as never) };
}

function taskRequest(subject: string): CreateTaskRequest {
  return { subject, requirements: REQUIREMENTS };
}

function makeCommand(commandId: string): { commandId: string; idempotencyKey: string } {
  return { commandId, idempotencyKey: commandId };
}
