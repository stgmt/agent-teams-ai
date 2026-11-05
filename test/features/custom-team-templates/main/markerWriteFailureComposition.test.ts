// @vitest-environment node
import fsDefault, * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_ROUTES,
} from '@features/custom-team-templates/contracts';
import { registerCustomTeamTemplatesHttp } from '@features/custom-team-templates/main/adapters/input/http/registerCustomTeamTemplatesHttp';
import { registerCustomTeamTemplatesIpc } from '@features/custom-team-templates/main/adapters/input/ipc/registerCustomTeamTemplatesIpc';
import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import { createInternalStorageFeature } from '@features/internal-storage/main/composition/createInternalStorageFeature';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { JsonTaskStallJournalStore } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import Database from 'better-sqlite3-node';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

import type { ListCustomTeamTemplateRecordsResult } from '@features/custom-team-templates/contracts';
import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';
import type { IpcMain } from 'electron';

const mutableFs = fsDefault as unknown as {
  writeFileSync: typeof fs.writeFileSync;
  lstatSync: typeof fs.lstatSync;
};

async function cleanup(root: string): Promise<void> {
  const parent = await fsp.realpath(os.tmpdir());
  const resolved = await fsp.realpath(root);
  const relative = path.relative(parent, resolved);
  if (!relative.startsWith('marker-failure-composition-') || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a path outside the test scratch parent');
  }
  await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

it('reports confirmed corruption even when the marker write fails and blocks unverified fallback after restart', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'marker-failure-composition-'));
  const directory = path.join(root, 'storage');
  const databasePath = path.join(directory, 'app.db');
  const markerPath = `${databasePath}.templates-recovery-required`;
  const interruptedMarkerPath = `${databasePath}.recovery-in-progress`;
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(databasePath, 'corrupt database; preserve');
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  const originalWrite = mutableFs.writeFileSync;
  let markerWrites = 0;
  mutableFs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === markerPath) {
      markerWrites += 1;
      throw Object.assign(new Error('injected marker EIO'), { code: 'EIO' });
    }
    return (originalWrite as (...values: unknown[]) => void)(file, ...args);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  const ping = vi
    .spyOn(InternalStorageWorkerClient.prototype, 'ping')
    .mockImplementation(async () => core.handle('ping', {}) as InternalStorageBackendInfo);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'customTeamTemplateList').mockImplementation(
    async () => core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const jsonUpdate = vi.spyOn(JsonTaskStallJournalStore.prototype, 'update');
  const storage = createInternalStorageFeature({ userDataPath: root });
  const feature = createCustomTeamTemplatesFeature({ backend: storage.customTeamTemplatesBackend });
  const handlers = new Map<string, (_event: unknown) => unknown>();
  registerCustomTeamTemplatesIpc(
    {
      handle: (name: string, handler: (_event: unknown) => unknown) => handlers.set(name, handler),
    } as unknown as IpcMain,
    feature
  );
  const http = Fastify();
  registerCustomTeamTemplatesHttp(http, feature);
  try {
    expect(await storage.probeBackend()).toBe('recovery-required');
    const expected = {
      status: 'recoveryRequired',
      storageDirectory: directory,
      markerPath,
      interruptedMarkerPath,
      markerWriteFailed: true,
    };
    expect(await handlers.get(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates)?.({})).toEqual(expected);
    const response = await http.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(markerWrites).toBe(1);
    await expect(fsp.stat(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.readFile(databasePath, 'utf8')).resolves.toBe('corrupt database; preserve');
    await expect(
      storage.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
    ).rejects.toThrow();
    expect(jsonUpdate).not.toHaveBeenCalled();
    await storage.dispose();

    // A different session cannot know that the missing marker means healthy storage.
    ping.mockRejectedValue(new Error('worker unavailable after restart'));
    const restarted = createInternalStorageFeature({ userDataPath: root });
    try {
      expect(await restarted.probeBackend()).toBe('verification-required');
      await expect(
        restarted.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
      ).rejects.toThrow(/verif/i);
      expect(jsonUpdate).not.toHaveBeenCalled();
    } finally {
      await restarted.dispose();
    }
  } finally {
    await http.close();
    feature.dispose();
    core.close();
    mutableFs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});

it('blocks fallback for a new profile before and after SQLite sidecars appear', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'marker-failure-composition-'));
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'ping').mockRejectedValue(
    new Error('worker offline')
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const feature = createInternalStorageFeature({ userDataPath: root });
  try {
    expect(await feature.probeBackend()).toBe('verification-required');
    const directory = path.join(root, 'storage');
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'app.db-wal'), 'unverified journal');
    expect(await feature.probeBackend()).toBe('verification-required');
    await expect(
      feature.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
    ).rejects.toThrow(/verif/i);
  } finally {
    await feature.dispose();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});

it('uses a successfully verified existing SQLite database', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'marker-failure-composition-'));
  const databasePath = path.join(root, 'storage', 'app.db');
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'ping').mockImplementation(
    async () => core.handle('ping', {}) as InternalStorageBackendInfo
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const feature = createInternalStorageFeature({ userDataPath: root });
  try {
    expect(await feature.probeBackend()).toBe('sqlite');
    expect((await fsp.stat(databasePath)).isFile()).toBe(true);
  } finally {
    await feature.dispose();
    core.close();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});

it('blocks fallback if database presence cannot be checked', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'marker-failure-composition-'));
  const databasePath = path.join(root, 'storage', 'app.db');
  const originalLstat = mutableFs.lstatSync;
  mutableFs.lstatSync = ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === databasePath)
      throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    return (originalLstat as (...values: unknown[]) => fs.Stats)(file, ...args);
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'ping').mockRejectedValue(
    new Error('worker offline')
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const feature = createInternalStorageFeature({ userDataPath: root });
  try {
    expect(await feature.probeBackend()).toBe('verification-required');
    await expect(
      feature.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
    ).rejects.toThrow(/verif/i);
  } finally {
    await feature.dispose();
    mutableFs.lstatSync = originalLstat;
    syncBuiltinESMExports();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});
