// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RegistryTaskClient } from '../registry/RegistryTaskClient';
import { TeamConfigReader } from '../TeamConfigReader';
import { TeamTaskReader } from '../TeamTaskReader';

import type { RegistryTaskClient as RegistryTaskClientType } from '../registry/RegistryTaskClient';

const TEAM = 'alpha-team';
const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const tempRoots: string[] = [];

async function createTeamDirectory(): Promise<{ root: string; teamDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-task-reader-registry-binding-'));
  tempRoots.push(root);
  const teamDir = path.join(root, 'teams', TEAM);
  await fs.mkdir(teamDir, { recursive: true });
  setClaudeBasePathOverride(root);
  return { root, teamDir };
}

async function writeDraftMetadata(teamDir: string, root: string): Promise<void> {
  await fs.writeFile(
    path.join(teamDir, 'team.meta.json'),
    JSON.stringify({ version: 1, cwd: root, specProject: PROJECT, specSlug: SPEC })
  );
}

function mockRegistryClient(listTasks: RegistryTaskClientType['listTasks']) {
  return vi
    .spyOn(RegistryTaskClient, 'create')
    .mockResolvedValue({ listTasks } as unknown as RegistryTaskClientType);
}

afterEach(async () => {
  vi.restoreAllMocks();
  setClaudeBasePathOverride(null);
  TeamConfigReader.clearCacheForTests();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('TeamTaskReader registry binding', () => {
  it('reads canonical tasks using draft metadata before config.json exists', async () => {
    const { root, teamDir } = await createTeamDirectory();
    await writeDraftMetadata(teamDir, root);
    const listTasks = vi.fn(async () => []);
    mockRegistryClient(listTasks);
    const tasks = await new TeamTaskReader().getTasks(TEAM);

    expect(tasks).toEqual([]);
    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, spec: SPEC })
    );
  });

  it('recovers draft binding from metadata when runtime config omits both fields', async () => {
    const { root, teamDir } = await createTeamDirectory();
    await writeDraftMetadata(teamDir, root);
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify({ name: TEAM }));
    const listTasks = vi.fn(async () => []);
    mockRegistryClient(listTasks);

    const tasks = await new TeamTaskReader().getTasks(TEAM);

    expect(tasks).toEqual([]);
    expect(listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ project: PROJECT, spec: SPEC })
    );
  });

  it.each([
    ['malformed config', '{invalid', 'SPEC_PROJECT_MISSING'],
    ['partial config', JSON.stringify({ name: TEAM, specProject: PROJECT }), 'SPEC_SLUG_MISSING'],
  ])('does not fall back to draft metadata for a %s', async (_description, config, causeCode) => {
    const { root, teamDir } = await createTeamDirectory();
    await writeDraftMetadata(teamDir, root);
    const createRegistryClient = vi.spyOn(RegistryTaskClient, 'create');
    await fs.writeFile(path.join(teamDir, 'config.json'), config);

    await expect(new TeamTaskReader().getTasks(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
      causeCode,
    });
    expect(createRegistryClient).not.toHaveBeenCalled();
  });
});
