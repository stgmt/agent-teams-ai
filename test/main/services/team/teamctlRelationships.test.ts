import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionTaskStore } from '../../../../src/main/services/team/execution/ExecutionTaskStore';
import { RegistryTeamTaskWriter } from '../../../../src/main/services/team/registry/RegistryTeamTaskWriter';
import type { RegistryTask, RegistryTaskWriteResult, ReplaceRegistryTaskLinksInput } from '../../../../src/main/services/team/registry/RegistryTaskClientTypes';
import type { RegistryTeamTaskClientPort } from '../../../../src/main/services/team/registry/RegistryTeamTaskWriter';

const SPEC = 'test-spec';
const ref = (id: string) => `${SPEC}:TASK-${id}`;
const tempPaths: string[] = [];

afterEach(() => {
  for (const dir of tempPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function task(id: string, overrides: Partial<RegistryTask> = {}): RegistryTask {
  return {
    canonicalId: ref(id), localId: id, title: `Task ${id}`, status: 'todo', owner: null,
    tracking: null, requirements: ['FR-1'], dependsOn: [], blocks: [], blockedBy: [],
    refs: [], contentHash: null, ...overrides,
  };
}

function setup(tasks: RegistryTask[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-relationships-'));
  tempPaths.push(dir);
  const applied = (): RegistryTaskWriteResult => ({ outcome: 'APPLIED', transitions: [], refusal: null });
  const replaceTaskLinks = vi.fn(async (input: ReplaceRegistryTaskLinksInput) => {
    const current = tasks.find((entry) => entry.localId === input.entity);
    if (!current) throw new Error(`Unexpected write to missing task ${input.entity}`);
    if (input.dependsOn) current.dependsOn = [...input.dependsOn];
    if (input.refs) current.refs = [...input.refs];
    return applied();
  });
  const client: RegistryTeamTaskClientPort = {
    readTasksDocumentSha: vi.fn(async () => 'a'.repeat(64)),
    confirmTaskCreation: vi.fn(async () => false),
    listTasks: vi.fn(async () => tasks),
    upsertTask: vi.fn(async () => applied()),
    replaceTaskStatus: vi.fn(async () => ({ outcome: 'APPLIED' as const, transitions: [] })),
    replaceTaskOwner: vi.fn(async () => applied()),
    replaceTaskLinks,
  };
  const writer = new RegistryTeamTaskWriter({
    teamName: 'test-team', binding: { project: 'test/project', spec: SPEC }, client,
    executionStore: new ExecutionTaskStore({ basePath: dir }),
  });
  return { writer, replaceTaskLinks };
}

describe('registry task relationships', () => {
  it('adds and removes blockedBy through the canonical dependsOn field', async () => {
    const tasks = [task('1'), task('2')];
    const { writer, replaceTaskLinks } = setup(tasks);
    await writer.addLink({ taskId: '2', targetId: '1', type: 'blockedBy' });
    expect(tasks[1].dependsOn).toEqual([ref('1')]);
    expect(replaceTaskLinks).toHaveBeenCalledWith(expect.objectContaining({ entity: '2', dependsOn: [ref('1')] }));
    await writer.removeLink({ taskId: '2', targetId: '1', type: 'blockedBy' });
    expect(tasks[1].dependsOn).toEqual([]);
  });

  it('maps blocks to the inverse dependency for addition and removal', async () => {
    const tasks = [task('1'), task('2')];
    const { writer } = setup(tasks);
    await writer.addLink({ taskId: '1', targetId: '2', type: 'blocks' });
    expect(tasks[1].dependsOn).toEqual([ref('1')]);
    await writer.removeLink({ taskId: '1', targetId: '2', type: 'blocks' });
    expect(tasks[1].dependsOn).toEqual([]);
  });

  it('does not duplicate an existing dependency', async () => {
    const tasks = [task('1'), task('2', { dependsOn: [ref('1')] })];
    const { writer } = setup(tasks);
    await writer.addLink({ taskId: '2', targetId: '1', type: 'blockedBy' });
    expect(tasks[1].dependsOn).toEqual([ref('1')]);
  });

  it('adds and removes related links in both directions', async () => {
    const tasks = [task('3'), task('4')];
    const { writer } = setup(tasks);
    await writer.addLink({ taskId: '3', targetId: '4', type: 'related' });
    expect(tasks.map((entry) => entry.refs)).toEqual([[ref('4')], [ref('3')]]);
    await writer.removeLink({ taskId: '3', targetId: '4', type: 'related' });
    expect(tasks.map((entry) => entry.refs)).toEqual([[], []]);
  });

  it('rejects normalized self-links and nonexistent source or target', async () => {
    const { writer, replaceTaskLinks } = setup([task('1')]);
    for (const type of ['blockedBy', 'blocks', 'related'] as const) {
      await expect(writer.addLink({ taskId: '1', targetId: 'TASK-1', type })).rejects.toMatchObject({ code: 'LINK_CYCLE' });
    }
    await expect(writer.addLink({ taskId: '1', targetId: '999', type: 'blockedBy' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(writer.addLink({ taskId: '999', targetId: '1', type: 'blockedBy' })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(replaceTaskLinks).not.toHaveBeenCalled();
  });

  it('rejects direct and transitive cycles while allowing redundant dependencies', async () => {
    const tasks = [task('1'), task('2', { dependsOn: [ref('1')] }), task('3', { dependsOn: [ref('2')] })];
    const { writer, replaceTaskLinks } = setup(tasks);
    await expect(writer.addLink({ taskId: '1', targetId: '2', type: 'blockedBy' })).rejects.toMatchObject({ code: 'LINK_CYCLE' });
    await expect(writer.addLink({ taskId: '1', targetId: '3', type: 'blockedBy' })).rejects.toMatchObject({ code: 'LINK_CYCLE' });
    expect(replaceTaskLinks).not.toHaveBeenCalled();
    await writer.addLink({ taskId: '3', targetId: '1', type: 'blockedBy' });
    expect(tasks[2].dependsOn).toEqual([ref('2'), ref('1')]);
  });

  it('removes a dependency whose target is missing without disturbing other links', async () => {
    const tasks = [task('2', { dependsOn: [ref('1'), ref('3')] })];
    const { writer } = setup(tasks);
    await writer.removeLink({ taskId: '2', targetId: '1', type: 'blockedBy' });
    expect(tasks[0].dependsOn).toEqual([ref('3')]);
    await writer.removeLink({ taskId: '2', targetId: '1', type: 'blockedBy' });
    expect(tasks[0].dependsOn).toEqual([ref('3')]);
  });
});
