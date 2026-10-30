// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeTeamDefinitionStore } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamDefinitionStore';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-team-definition-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  const tasksRoot = join(root, 'tasks');
  const store = new NodeTeamDefinitionStore({
    teamsRoot,
    tasksRoot,
    metadata: new TeamMetaStore(),
    members: new TeamMembersMetaStore(),
    invalidate() {},
  });
  const request = {
    teamName: 'test-definition',
    cwd: root,
    providerId: 'anthropic' as const,
    model: 'TEST-model',
    effort: 'high' as const,
    prompt: 'TEST work',
    members: [{ name: 'builder', role: 'Builder', workflow: 'TEST build' }],
  };
  return { root, teamsRoot, tasksRoot, store, request };
}

describe('app-owned canonical team definition creation', () => {
  it('creates both complete canonical documents and private inbox/task directories without a model or CLI', async () => {
    const { store, request, teamsRoot, tasksRoot } = await setup();
    await store.create(request, new AbortController().signal);
    const team = join(teamsRoot, request.teamName);
    const meta = JSON.parse(await readFile(join(team, 'team.meta.json'), 'utf8'));
    const members = JSON.parse(await readFile(join(team, 'members.meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      version: 1,
      runtimeSelectionVersion: 1,
      providerId: 'anthropic',
      cwd: request.cwd,
      model: 'TEST-model',
      effort: 'high',
      prompt: 'TEST work',
    });
    expect(members.members).toHaveLength(1);
    expect(members.members[0]).toMatchObject({
      name: 'builder',
      role: 'Builder',
      workflow: 'TEST build',
      agentType: 'general-purpose',
    });
    expect(members.members[0].model).toBeUndefined();
    expect(await readdir(team)).toEqual(
      expect.arrayContaining(['team.meta.json', 'members.meta.json', 'inboxes'])
    );
    expect(await readdir(join(tasksRoot, request.teamName))).toEqual([]);
    await expect(readFile(join(team, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an unresolved draft explicitly rather than inventing a provider', async () => {
    const { store, request, teamsRoot } = await setup();
    await store.create(
      { teamName: request.teamName, members: request.members },
      new AbortController().signal
    );
    const meta = JSON.parse(
      await readFile(join(teamsRoot, request.teamName, 'team.meta.json'), 'utf8')
    );
    expect(meta.runtimeSelectionVersion).toBe(1);
    expect(meta.providerId).toBeUndefined();
    expect(meta.cwd).toBe('');
  });

  it('never replaces an existing team or task directory and serializes concurrent creation by ownership', async () => {
    const { store, request, teamsRoot } = await setup();
    const results = await Promise.allSettled([
      store.create(request, new AbortController().signal),
      store.create(request, new AbortController().signal),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const before = await readFile(join(teamsRoot, request.teamName, 'team.meta.json'), 'utf8');
    await expect(store.create(request, new AbortController().signal)).rejects.toThrow('exists');
    expect(await readFile(join(teamsRoot, request.teamName, 'team.meta.json'), 'utf8')).toBe(
      before
    );
  });

  it('rolls back only its own empty team when the task directory is already owned elsewhere', async () => {
    const { store, request, teamsRoot, tasksRoot } = await setup();
    await mkdir(join(tasksRoot, request.teamName), { recursive: true });
    await writeFile(join(tasksRoot, request.teamName, 'keep.txt'), 'TEST keep');
    await expect(store.create(request, new AbortController().signal)).rejects.toThrow('exists');
    expect(await readFile(join(tasksRoot, request.teamName, 'keep.txt'), 'utf8')).toBe('TEST keep');
    expect(await readdir(teamsRoot)).not.toContain(request.teamName);
  });

  it('rejects a cancelled or invalid definition before publishing directories', async () => {
    const { store, request, teamsRoot } = await setup();
    const abort = new AbortController();
    abort.abort();
    await expect(store.create(request, abort.signal)).rejects.toThrow();
    for (const patch of [
      { members: [{ name: 'team-lead' }] },
      { members: [{ name: 'builder' }, { name: 'Builder' }] },
      { providerId: undefined, model: 'TEST-model' },
      { providerId: 'codex', providerBackendId: 'api' },
    ]) {
      await expect(
        store.create({ ...request, ...patch } as typeof request, new AbortController().signal)
      ).rejects.toThrow();
    }
    await expect(readdir(teamsRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
