import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionTaskStore } from '../../../../src/main/services/team/execution/ExecutionTaskStore';
import { RegistryTaskProvider } from '../../../../src/main/services/team/registry/RegistryTaskProvider';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { RegistryTaskClient } from '../../../../src/main/services/team/registry/RegistryTaskClient';
import type { RegistryTask } from '../../../../src/main/services/team/registry/RegistryTaskClientTypes';
import type { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';

const TEAM = 'atlas-hq';
const PROJECT = 'sandbox/project';
const SPEC = 'sample-spec';
const tempPaths: string[] = [];

function registryTask(id: string, overrides: Partial<RegistryTask> = {}): RegistryTask {
  return {
    canonicalId: `${SPEC}:TASK-${id}`,
    localId: id,
    title: `Task ${id}`,
    status: 'todo',
    owner: null,
    tracking: null,
    requirements: [],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    refs: [],
    contentHash: null,
    ...overrides,
  };
}

async function createReader(
  listTasks: () => Promise<RegistryTask[]>,
  config: unknown = { name: TEAM, specProject: PROJECT, specSlug: SPEC }
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-task-reader-'));
  tempPaths.push(root);
  const executionStore = new ExecutionTaskStore({ basePath: path.join(root, 'tasks-local') });
  const provider = new RegistryTaskProvider({
    readConfig: async () => config,
    clientFactory: async () => ({ listTasks }) as unknown as RegistryTaskClient,
    executionStore,
  });
  const configReader = { listTeamNames: async () => [TEAM] } as unknown as TeamConfigReader;
  return { root, executionStore, reader: new TeamTaskReader(configReader, provider) };
}

afterEach(async () => {
  TeamTaskReader.invalidateAllTasksCache();
  setClaudeBasePathOverride(null);
  await Promise.all(tempPaths.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  ));
});

describe('TeamTaskReader', () => {
  it('does not let an invalidated in-flight read replace newer registry data', async () => {
    let entered!: () => void;
    let release!: (tasks: RegistryTask[]) => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const staleResponse = new Promise<RegistryTask[]>((resolve) => { release = resolve; });
    const listTasks = vi.fn()
      .mockImplementationOnce(() => { entered(); return staleResponse; })
      .mockResolvedValue([registryTask('2', { title: 'Fresh task' })]);
    const { reader } = await createReader(listTasks);

    const staleRead = reader.getAllTasks();
    await enteredPromise;
    TeamTaskReader.invalidateAllTasksCache();
    expect(await reader.getAllTasks()).toMatchObject([{ id: '2', subject: 'Fresh task', teamName: TEAM }]);
    release([registryTask('1', { title: 'Old task' })]);
    await expect(staleRead).resolves.toMatchObject([{ id: '1', subject: 'Old task' }]);
    expect(await reader.getAllTasks()).toMatchObject([{ id: '2', subject: 'Fresh task' }]);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('isolates cached registry data from changes made by a caller', async () => {
    const listTasks = vi.fn().mockResolvedValue([
      registryTask('1', { dependsOn: [`${SPEC}:TASK-2`] }),
    ]);
    const { reader } = await createReader(listTasks);
    const first = await reader.getTasks(TEAM);
    first[0]!.subject = 'Changed by caller';
    first[0]!.blockedBy!.push('3');

    expect(await reader.getTasks(TEAM)).toMatchObject([{ subject: 'Task 1', blockedBy: ['2'] }]);
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  it('preserves blockers and local metadata in the global projection without shortening full reads', async () => {
    const longComment = 'full comment '.repeat(500);
    const { reader, executionStore } = await createReader(async () => [
      registryTask('1', { dependsOn: [`${SPEC}:TASK-2`] }),
    ]);
    executionStore.write(TEAM, '1', {
      groupChatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      comments: [{ id: 'comment-1', type: 'regular', author: 'alice', text: longComment, createdAt: '2026-05-02T12:00:00.000Z' }],
    });

    const projection = await reader.getAllTasksProjectionSnapshot();
    expect(projection).toMatchObject([{
      id: '1', teamName: TEAM, blockedBy: ['2'], groupChatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }]);
    expect(projection[0]!.comments![0]!.text.length).toBeLessThan(longComment.length);
    expect((await reader.getTasks(TEAM))[0]!.comments![0]!.text).toBe(longComment);
  });

  it('includes deleted and completed tasks when choosing the next task number', async () => {
    const { reader } = await createReader(async () => [
      registryTask('1'), registryTask('50', { status: 'done' }), registryTask('99', { status: 'deleted' }),
    ]);
    expect((await reader.getTasks(TEAM)).map((task) => task.id)).toEqual(['1', '50']);
    expect((await reader.getDeletedTasks(TEAM)).map((task) => task.id)).toEqual(['99']);
    expect(await reader.getNextTaskId(TEAM)).toBe('100');
  });

  it('rejects an unbound team even when an old local task file exists', async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const { root, reader } = await createReader(listTasks, { name: TEAM });
    setClaudeBasePathOverride(root);
    const legacyDir = path.join(root, 'tasks', TEAM);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, '1.json'), JSON.stringify({ id: '1', subject: 'Stale local task' }));

    await expect(reader.getTasks(TEAM)).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_INCOMPLETE' });
    expect(listTasks).not.toHaveBeenCalled();
  });
});
