import { beforeEach, describe, expect, it, vi } from 'vitest';

const atomicWriteAsync = vi.hoisted(() =>
  vi.fn(async (_path: string, _content: string) => undefined)
);

vi.mock('../atomicWrite', () => ({ atomicWriteAsync }));
vi.mock('../fileLock', () => ({
  withFileLock: (_path: string, run: () => Promise<unknown>) => run(),
}));

import { TeamMetaStore } from '../TeamMetaStore';
import { hasCompleteKnownMetadata } from '../TeamMetadataReadFidelity';

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
    expect(JSON.parse(atomicWriteAsync.mock.calls[0]![1])).toMatchObject({
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
      specBindings: [{ project: 'owner/project', spec: 'example' }],
    };
    const normalized = JSON.parse(new TeamMetaStore().serializeMeta(value));
    expect(normalized).toMatchObject(value);
    expect(hasCompleteKnownMetadata(value, normalized)).toBe(true);
    expect(hasCompleteKnownMetadata(value, { ...normalized, specBindings: [] })).toBe(false);
  });
});
