// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as atomicWrite from '@main/utils/atomicWrite';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../TeamConfigReader';
import { withFileLock } from '../fileLock';

const TEAM = 'registry-config-team';

describe('TeamConfigReader spec binding persistence', () => {
  it('validates bindings and atomically preserves the rest of the team config', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-bindings-'));
    setClaudeBasePathOverride(root);
    const configPath = path.join(root, 'teams', TEAM, 'config.json');
    const original = {
      name: 'Registry Team',
      description: 'preserved description',
      projectPath: 'C:/projects/registry-team',
      projectPathHistory: ['C:/projects/old', 'C:/projects/registry-team'],
      members: [{ name: 'lead', role: 'lead' }],
      customSettings: { retain: true },
      specBindings: [{ project: 'owner/old', spec: 'old-spec' }],
    };
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(original), 'utf8');
      const reader = new TeamConfigReader();
      const replacement = [{ project: 'owner/new', spec: 'new-spec' }];

      await expect(reader.updateSpecBindings(TEAM, replacement)).resolves.toMatchObject({
        ...original,
        specBindings: replacement,
      });
      const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as typeof original;
      expect(written).toEqual({ ...original, specBindings: replacement });

      await expect(
        reader.updateSpecBindings(TEAM, [...replacement, ...replacement])
      ).rejects.toMatchObject({
        code: 'SPEC_BINDING_DUPLICATE',
      });
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(JSON.stringify(written, null, 2));
      await expect(reader.getConfig(TEAM)).resolves.toMatchObject({ specBindings: replacement });
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('does not write equivalent normalized bindings and reads the latest config under the writer lock', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-idempotence-'));
    setClaudeBasePathOverride(root);
    const configPath = path.join(root, 'teams', TEAM, 'config.json');
    const initial = {
      name: 'Registry Team',
      members: [{ name: 'lead', role: 'lead' }],
      description: 'before',
      specBindings: [{ project: 'owner/old', spec: 'old-spec' }],
      customSettings: { retain: true },
    };
    const writeSpy = vi.spyOn(atomicWrite, 'atomicWriteAsync');
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(initial), 'utf8');
      const reader = new TeamConfigReader();
      await reader.getConfigSnapshot(TEAM);

      let releaseLock!: () => void;
      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const latest = {
        ...initial,
        description: 'updated by another writer',
        specBindings: [{ project: ' owner/new ', spec: ' new-spec ' }],
      };
      const latestRaw = JSON.stringify(latest);
      const otherWriter = withFileLock(configPath, async () => {
        await fs.writeFile(configPath, latestRaw, 'utf8');
        signalLocked();
        await release;
      });
      await locked;
      const update = reader.updateSpecBindings(TEAM, [{ project: 'owner/new', spec: 'new-spec' }]);
      releaseLock();
      await otherWriter;
      await expect(update).resolves.toMatchObject(latest);
      expect(writeSpy).not.toHaveBeenCalled();
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(latestRaw);

      const replacement = [{ project: 'owner/next', spec: 'next-spec' }];
      await Promise.all([
        reader.updateSpecBindings(TEAM, replacement),
        new TeamConfigReader().updateConfig(TEAM, { color: 'blue' }),
      ]);
      expect(JSON.parse(await fs.readFile(configPath, 'utf8'))).toEqual({
        ...latest,
        specBindings: replacement,
        color: 'blue',
      });
    } finally {
      writeSpy.mockRestore();
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});
