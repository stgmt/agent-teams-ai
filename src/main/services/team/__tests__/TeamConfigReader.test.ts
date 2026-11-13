// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as atomicWrite from '@main/utils/atomicWrite';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { describe, expect, it, vi } from 'vitest';

import { withFileLock } from '../fileLock';
import { TeamConfigReader } from '../TeamConfigReader';

import type { TeamSpecScope } from '@shared/types';

const TEAM = 'registry-config-team';
const scopeFor = (spec: string): TeamSpecScope => ({
  projects: ['owner/project'],
  bindings: [{ project: 'owner/project', spec }],
});

async function fixture(scope: TeamSpecScope) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-scope-'));
  setClaudeBasePathOverride(root);
  const directory = path.join(root, 'teams', TEAM);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'team.meta.json'),
    JSON.stringify({
      version: 1,
      cwd: root,
      createdAt: 1,
      specScope: scope,
    })
  );
  return {
    configPath: path.join(directory, 'config.json'),
    dispose: async () => {
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
}

describe('TeamConfigReader canonical scope persistence', () => {
  it('atomically projects metadata-owned scope while migrating legacy fields and preserving other settings', async () => {
    const scope = scopeFor('new-spec');
    const { configPath, dispose } = await fixture(scope);
    const original = {
      name: 'Registry Team',
      description: 'preserved',
      members: [{ name: 'lead', role: 'lead' }],
      projectPath: 'C:/projects/team',
      customSettings: { retain: true },
      specProject: 'owner/project',
      specSlug: 'old-spec',
    };
    try {
      await fs.writeFile(configPath, JSON.stringify(original));
      const reader = new TeamConfigReader();
      const written = await reader.updateSpecScope(TEAM, scope);
      const { specProject: _project, specSlug: _slug, ...retained } = original;
      expect(written).toEqual({ ...retained, specScope: scope });
      expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual(written);
      await expect(
        reader.updateSpecScope(TEAM, {
          ...scope,
          bindings: [...scope.bindings, ...scope.bindings],
        })
      ).rejects.toMatchObject({ code: 'SPEC_BINDING_DUPLICATE' });
      await expect(reader.getConfig(TEAM)).resolves.toMatchObject({ specScope: scope });
    } finally {
      await dispose();
    }
  });

  it('reads under the existing writer lock and skips equivalent scope writes', async () => {
    const scope = scopeFor('current-spec');
    const { configPath, dispose } = await fixture(scope);
    const initial = { name: 'Registry Team', members: [], description: 'before', specScope: scope };
    const spy = vi.spyOn(atomicWrite, 'atomicWriteAsync');
    try {
      await fs.writeFile(configPath, JSON.stringify(initial));
      const reader = new TeamConfigReader();
      await reader.getConfigSnapshot(TEAM);
      spy.mockClear();
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let releaseLock!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const latest = { ...initial, description: 'updated by another writer' };
      const raw = JSON.stringify(latest);
      const other = withFileLock(configPath, async () => {
        await fs.writeFile(configPath, raw);
        signalLocked();
        await released;
      });
      await locked;
      const update = reader.updateSpecScope(TEAM, scope);
      releaseLock();
      await other;
      await expect(update).resolves.toEqual(latest);
      expect(spy).not.toHaveBeenCalled();
      expect(await fs.readFile(configPath, 'utf8')).toBe(raw);
      await Promise.all([
        reader.updateSpecScope(TEAM, scope),
        new TeamConfigReader().updateConfig(TEAM, { color: 'blue' }),
      ]);
      expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
        ...latest,
        color: 'blue',
      });
    } finally {
      spy.mockRestore();
      await dispose();
    }
  });

  it('migrates a matching legacy projection once before returning it to consumers', async () => {
    const scope = scopeFor('existing-spec');
    const { configPath, dispose } = await fixture(scope);
    const spy = vi.spyOn(atomicWrite, 'atomicWriteAsync');
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          name: 'Registry Team',
          members: [],
          specProject: 'owner/project',
          specSlug: 'existing-spec',
        })
      );
      expect(await new TeamConfigReader().getConfig(TEAM)).toMatchObject({ specScope: scope });
      const migrated = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(migrated).not.toHaveProperty('specProject');
      expect(migrated).not.toHaveProperty('specSlug');
      expect(spy).toHaveBeenCalledOnce();
      expect(await new TeamConfigReader().getConfig(TEAM)).toMatchObject({ specScope: scope });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await dispose();
    }
  });

  it('refuses a runtime projection that widens metadata-owned projects without destroying it', async () => {
    const { configPath, dispose } = await fixture(scopeFor('existing-spec'));
    const original = JSON.stringify({
      name: 'Registry Team',
      members: [],
      specScope: { projects: ['other/project'], bindings: [] },
    });
    try {
      await fs.writeFile(configPath, original);
      await expect(new TeamConfigReader().getConfig(TEAM)).rejects.toMatchObject({
        code: 'SPEC_BINDINGS_INVALID',
      });
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    } finally {
      await dispose();
    }
  });
});
