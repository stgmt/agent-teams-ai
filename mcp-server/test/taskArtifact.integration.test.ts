import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as controllerModule from '../src/controller';
import { registerTaskTools } from '../src/tools/taskTools';

const { createController } = createRequire(import.meta.url)(
  '../../agent-teams-controller/src/index.js'
);
const taskStore = createRequire(import.meta.url)(
  '../../agent-teams-controller/src/internal/taskStore.js'
);

type Tool = {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute(args: Record<string, unknown>): Promise<unknown>;
};

const APP_BINDING_ENV_KEYS = [
  'AGENT_TEAMS_BOUND_CONTROL_URL',
  'AGENT_TEAMS_BOUND_CONTEXT_JSON',
  'AGENT_TEAMS_MCP_CLAUDE_DIR',
] as const;

describe('required artifacts through MCP tools', () => {
  let dir = '';
  let previousBindingEnvironment: Record<string, string | undefined>;
  beforeEach(() => {
    previousBindingEnvironment = Object.fromEntries(
      APP_BINDING_ENV_KEYS.map((key) => [key, process.env[key]])
    );
    // These cases run the controller's local task board, which is only
    // selectable when no app binding is installed.
    for (const key of APP_BINDING_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of APP_BINDING_ENV_KEYS) {
      const value = previousBindingEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dir) {
      const target = path.resolve(dir);
      if (
        !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
        !path.basename(target).startsWith('mcp-artifact-test-')
      ) {
        throw new Error('Refusing to remove a non-fixture path');
      }
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
    dir = '';
  });

  it('registers the owner attachment tool and prevents completion of a changed or missing file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-artifact-test-'));
    const teamName = 'fixture';
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const teamDir = path.join(dir, 'teams', teamName);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath: project,
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    const desktop = createController({ teamName, claudeDir: dir, localTaskBoard: true }).taskBoard;
    const task = desktop.createTask({ subject: 'Artifact task', owner: 'worker' });
    desktop.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactExpectedFilename: 'result.txt',
    });
    vi.spyOn(controllerModule, 'getController').mockImplementation((name, claudeDir) =>
      createController({
        teamName: name,
        claudeDir,
        allowUserMessageSender: false,
        localTaskBoard: true,
      })
    );
    const tools = new Map<string, Tool>();
    registerTaskTools({ addTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
    const attach = tools.get('task_set_artifact_file')!;
    const complete = tools.get('task_complete')!;
    const setStatus = tools.get('task_set_status')!;
    const args = { teamName, claudeDir: dir, taskId: task.id, actor: 'worker' };
    const payload = { filename: 'result.txt', base64Data: Buffer.from('first').toString('base64') };
    expect(attach.parameters.safeParse({ ...args, ...payload }).success).toBe(true);
    expect(attach.parameters.safeParse({ teamName, taskId: task.id, ...payload }).success).toBe(
      false
    );
    expect(attach.parameters.safeParse({ ...args, relativePath: 'result.txt' }).success).toBe(
      false
    );
    await expect(complete.execute(args)).rejects.toThrow(/not been attached/);
    await expect(attach.execute({ ...args, ...payload, filename: 'decoy.txt' })).rejects.toThrow(
      /result.txt/
    );
    const response = await attach.execute({ ...args, ...payload });
    const result = JSON.parse((response as { content: { text: string }[] }).content[0]!.text);
    expect(result.artifactRequirement.proof).toMatchObject({ size: 5, sha256: expect.any(String) });
    const file = desktop
      .getTask(task.id)
      .attachments.find(
        (item: { id: string }) => item.id === result.artifactRequirement.proof.attachmentId
      ).filePath;
    fs.writeFileSync(file, 'other');
    await expect(complete.execute(args)).rejects.toThrow(/has changed/);
    await expect(setStatus.execute({ ...args, status: 'completed' })).rejects.toThrow(
      /has changed/
    );
    fs.unlinkSync(file);
    await expect(complete.execute(args)).rejects.toThrow(/cannot be verified/);
    fs.writeFileSync(file, 'first');
    await complete.execute(args);
    expect(desktop.getTask(task.id).status).toBe('completed');
    const legacy = desktop.createTask({ subject: 'Legacy task', owner: 'worker' });
    const legacyArgs = { ...args, taskId: legacy.id };
    await complete.execute(legacyArgs);
    await expect(attach.execute({ ...legacyArgs, ...payload })).rejects.toThrow(/does not require/);
    expect(desktop.getTask(legacy.id).artifactRequirement).toBeUndefined();
  });

  it('reports an uncertain transition through task_get and task_list tools', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-artifact-test-'));
    const teamDir = path.join(dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    const board = createController({
      teamName: 'fixture',
      claudeDir: dir,
      localTaskBoard: true,
    }).taskBoard;
    const task = board.createTask({ subject: 'fixture', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    const original = taskStore.updateTask;
    const spy = vi.spyOn(taskStore, 'updateTask').mockImplementationOnce((...args: unknown[]) => {
      original(...args);
      throw Object.assign(new Error('post-commit EIO'), { code: 'EIO' });
    });
    try {
      expect(() => board.requestReview(task.id, { from: 'worker' })).toThrow(/may have completed/);
    } finally {
      spy.mockRestore();
    }
    vi.spyOn(controllerModule, 'getController').mockImplementation((teamName, claudeDir) =>
      createController({
        teamName,
        claudeDir,
        allowUserMessageSender: false,
        localTaskBoard: true,
      })
    );
    const tools = new Map<string, Tool>();
    registerTaskTools({ addTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
    await expect(
      tools.get('task_get')!.execute({ teamName: 'fixture', claudeDir: dir, taskId: task.id })
    ).rejects.toMatchObject({ code: 'KANBAN_TRANSITION_UNCERTAIN' });
    await expect(
      tools.get('task_list')!.execute({ teamName: 'fixture', claudeDir: dir })
    ).rejects.toMatchObject({ code: 'KANBAN_TRANSITION_UNCERTAIN' });
  });
});
