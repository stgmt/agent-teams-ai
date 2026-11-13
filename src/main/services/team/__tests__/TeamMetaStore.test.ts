import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const atomicWriteAsync = vi.hoisted(() =>
  vi.fn(async (_path: string, _content: string): Promise<void> => undefined)
);

vi.mock('../atomicWrite', () => ({ atomicWriteAsync }));
vi.mock('../fileLock', () => ({
  withFileLock: (_path: string, run: () => Promise<unknown>) => run(),
}));

import { hasCompleteKnownMetadata } from '../TeamMetadataReadFidelity';
import { TeamMetaStore } from '../TeamMetaStore';

import type { TeamMetaFile } from '../TeamMetaStore';

const initialMeta: TeamMetaFile = {
  version: 1,
  cwd: '/sandbox/team',
  model: 'old-model',
  effort: 'low',
  createdAt: 1,
};

describe('TeamMetaStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes writes behind an in-flight metadata read-modify-write', async () => {
    const updatingStore = new TeamMetaStore();
    const writingStore = new TeamMetaStore();
    vi.spyOn(updatingStore, 'getMeta').mockResolvedValue(initialMeta);
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateRead!: () => void;
    const updateReadSignal = new Promise<void>((resolve) => {
      updateRead = resolve;
    });
    const update = updatingStore.updateMeta('alpha', async (current) => {
      updateRead();
      await updateGate;
      if (!current) throw new Error('missing metadata');
      return { ...current, model: 'new-model', effort: 'high' };
    });
    await updateReadSignal;

    const write = writingStore.writeMeta('alpha', {
      cwd: '/sandbox/team',
      model: 'other-model',
      effort: 'medium',
      createdAt: 1,
    });
    await Promise.resolve();
    expect(atomicWriteAsync).not.toHaveBeenCalled();

    releaseUpdate();
    await Promise.all([update, write]);

    expect(atomicWriteAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(atomicWriteAsync.mock.calls[0]?.[1])).toMatchObject({
      model: 'new-model',
      effort: 'high',
    });
    expect(JSON.parse(atomicWriteAsync.mock.calls[1]?.[1])).toMatchObject({
      model: 'other-model',
      effort: 'medium',
    });
  });

  it('skips normalized no-op updates while retaining changes and durable-field fencing', async () => {
    const store = new TeamMetaStore();
    const current = { ...initialMeta, registryTeamId: 'registry-id' };
    vi.spyOn(store, 'getMeta').mockImplementation(async () => structuredClone(current));

    await store.updateMeta('alpha', (meta) => ({ ...meta!, model: ' old-model ' }));
    expect(atomicWriteAsync).not.toHaveBeenCalled();

    await expect(
      store.updateMeta('alpha', (meta) => ({
        ...meta!,
        registryTeamId: 'different-id',
      }))
    ).rejects.toThrow('Cannot change durable registryTeamId');
    expect(atomicWriteAsync).not.toHaveBeenCalled();
    await expect(
      store.updateMeta('alpha', (meta) => {
        meta!.registryTeamId = 'different-id';
        return meta!;
      })
    ).rejects.toThrow('Cannot change durable registryTeamId');
    expect(atomicWriteAsync).not.toHaveBeenCalled();

    await store.updateMeta('alpha', (meta) => {
      meta!.model = 'new-model';
      return meta!;
    });
    expect(atomicWriteAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(atomicWriteAsync.mock.calls[0][1])).toMatchObject({
      model: 'new-model',
      registryTeamId: 'registry-id',
    });
  });

  it('persists an explicit disabled lead-model sync preference', async () => {
    await new TeamMetaStore().writeMeta('alpha', {
      cwd: '/sandbox/team',
      syncModelsWithLead: false,
      createdAt: 1,
    });

    expect(JSON.parse(atomicWriteAsync.mock.calls[0]?.[1])).toMatchObject({
      syncModelsWithLead: false,
    });
  });

  it('retains registry binding and registration state during serialization', () => {
    const value = {
      cwd: '/sandbox/team',
      createdAt: 1,
      registryTeamId: 'team-id',
      registryRegistrationRequestId: 'request-id',
      registryRegistrationCompleted: false,
      specScope: {
        projects: ['owner/project'],
        bindings: [{ project: 'owner/project', spec: 'example' }],
      },
    };
    const normalized = JSON.parse(new TeamMetaStore().serializeMeta(value));
    expect(normalized).toMatchObject(value);
    expect(hasCompleteKnownMetadata(value, normalized)).toBe(true);
    expect(
      hasCompleteKnownMetadata(value, {
        ...normalized,
        specScope: { projects: ['owner/project'], bindings: [] },
      })
    ).toBe(false);
  });

  it('migrates a UI binding on a real metadata update once and preserves it after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-scope-migration-'));
    const teamPath = join(root, 'alpha');
    const metaPath = join(teamPath, 'team.meta.json');
    await mkdir(teamPath);
    await writeFile(
      metaPath,
      JSON.stringify({
        ...initialMeta,
        specProject: 'owner/project',
        specSlug: 'first-spec',
        registryTeamId: 'existing-team',
      })
    );
    atomicWriteAsync.mockImplementation(async (path, content) => writeFile(path, content));
    try {
      await new TeamMetaStore().updateMeta(
        'alpha',
        (meta) => ({ ...meta!, prompt: 'Updated team instructions' }),
        root
      );
      const migratedBytes = await readFile(metaPath, 'utf8');
      const persisted = JSON.parse(migratedBytes);
      expect(persisted).toMatchObject({
        specScope: {
          projects: ['owner/project'],
          bindings: [{ project: 'owner/project', spec: 'first-spec' }],
        },
        registryTeamId: 'existing-team',
        prompt: 'Updated team instructions',
      });
      for (const field of ['specProject', 'specSlug', 'specBindings']) {
        expect(persisted).not.toHaveProperty(field);
      }
      const writesAfterMigration = atomicWriteAsync.mock.calls.length;
      const reopened = new TeamMetaStore();
      await reopened.updateMeta('alpha', (meta) => ({ ...meta! }), root);
      expect(await reopened.getMeta('alpha', root)).toMatchObject({
        specScope: persisted.specScope,
      });
      expect(atomicWriteAsync).toHaveBeenCalledTimes(writesAfterMigration);
      expect(await readFile(metaPath, 'utf8')).toBe(migratedBytes);
    } finally {
      atomicWriteAsync.mockImplementation(async () => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a malformed legacy migration without overwriting the original operator data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-scope-invalid-'));
    const teamPath = join(root, 'alpha');
    const metaPath = join(teamPath, 'team.meta.json');
    const original = JSON.stringify({
      ...initialMeta,
      specProject: 'owner/project',
      specSlug: 'INVALID_SLUG',
      registryTeamId: 'existing-team',
    });
    await mkdir(teamPath);
    await writeFile(metaPath, original);
    atomicWriteAsync.mockImplementation(async (path, content) => writeFile(path, content));
    try {
      await expect(
        new TeamMetaStore().updateMeta(
          'alpha',
          (meta) => ({ ...meta!, prompt: 'must not replace malformed scope' }),
          root
        )
      ).rejects.toThrow();
      expect(await readFile(metaPath, 'utf8')).toBe(original);
      expect(atomicWriteAsync).not.toHaveBeenCalled();
    } finally {
      atomicWriteAsync.mockImplementation(async () => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
