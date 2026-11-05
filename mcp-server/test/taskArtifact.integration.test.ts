import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as controllerModule from '../src/controller';
import { registerTaskTools } from '../src/tools/taskTools';

const { createController } = createRequire(import.meta.url)(
  '../../agent-teams-controller/src/index.js'
);

type Tool = {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute(args: Record<string, unknown>): Promise<unknown>;
};

describe('required artifacts through MCP tools', () => {
  let dir = '';
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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
    const desktop = createController({ teamName, claudeDir: dir }).taskBoard;
    const task = desktop.createTask({ subject: 'Artifact task', owner: 'worker' });
    desktop.updateTaskFields(task.id, { artifactRequired: true });
    vi.spyOn(controllerModule, 'getController').mockImplementation((name, claudeDir) =>
      createController({ teamName: name, claudeDir, allowUserMessageSender: false })
    );
    const tools = new Map<string, Tool>();
    registerTaskTools({ addTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
    const attach = tools.get('task_set_artifact_file')!;
    const complete = tools.get('task_complete')!;
    const setStatus = tools.get('task_set_status')!;
    const args = { teamName, claudeDir: dir, taskId: task.id, actor: 'worker' };
    expect(attach.parameters.safeParse({ ...args, relativePath: 'result.txt' }).success).toBe(true);
    expect(
      attach.parameters.safeParse({ teamName, taskId: task.id, relativePath: 'result.txt' }).success
    ).toBe(false);
    await expect(complete.execute(args)).rejects.toThrow(/not been attached/);
    const file = path.join(project, 'result.txt');
    fs.writeFileSync(file, 'first');
    const response = await attach.execute({ ...args, relativePath: 'result.txt' });
    const result = JSON.parse((response as { content: { text: string }[] }).content[0]!.text);
    expect(result.artifactRequirement.proof).toMatchObject({ size: 5, sha256: expect.any(String) });
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
  });
});
