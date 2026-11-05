import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_ROUTES,
} from '@features/custom-team-templates/contracts';
import { registerCustomTeamTemplatesHttp } from '@features/custom-team-templates/main/adapters/input/http/registerCustomTeamTemplatesHttp';
import { registerCustomTeamTemplatesIpc } from '@features/custom-team-templates/main/adapters/input/ipc/registerCustomTeamTemplatesIpc';
import { createCustomTeamTemplatesFeature } from '@features/custom-team-templates/main/composition/createCustomTeamTemplatesFeature';
import { SqliteTaskStallJournalStore } from '@features/internal-storage/main/adapters/output/SqliteTaskStallJournalStore';
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

async function cleanup(root: string): Promise<void> {
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(root);
  const relative = path.relative(parent, target);
  if (
    (!relative.startsWith('interrupted-storage-composition-') &&
      !relative.startsWith('corrupt-storage-composition-')) ||
    relative.includes(path.sep)
  ) {
    throw new Error('Refusing to remove a path outside the test scratch parent');
  }
  await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

it('exposes interrupted recovery through real composition, IPC and HTTP after blocked fallback and restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interrupted-storage-composition-'));
  const directory = path.join(root, 'storage');
  const databasePath = path.join(directory, 'app.db');
  const markerPath = `${databasePath}.templates-recovery-required`;
  const interruptedMarkerPath = `${databasePath}.recovery-in-progress`;
  await fs.mkdir(directory, { recursive: true });
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'ping').mockRejectedValue(
    new Error('worker offline')
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'customTeamTemplateList').mockImplementation(
    async () => core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const jsonUpdate = vi
    .spyOn(JsonTaskStallJournalStore.prototype, 'update')
    .mockImplementation(async () => {
      throw new Error('JSON write should be blocked');
    });
  const sqliteUpdate = vi
    .spyOn(SqliteTaskStallJournalStore.prototype, 'update')
    .mockImplementation(async () => {
      throw new Error('SQLite write should be blocked');
    });
  const storage = createInternalStorageFeature({ userDataPath: root });
  try {
    // Worker failure is closed before a recovery marker exists.
    expect(await storage.probeBackend()).toBe('verification-required');
    await fs.writeFile(markerPath, 'marker');
    await fs.writeFile(interruptedMarkerPath, 'interrupted');
    expect(await storage.probeBackend()).toBe('recovery-required');
    await expect(
      storage.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
    ).rejects.toThrow(/manual recovery/);
    expect(jsonUpdate).not.toHaveBeenCalled();
    expect(sqliteUpdate).not.toHaveBeenCalled();
    const beforeRestart = createCustomTeamTemplatesFeature({
      backend: storage.customTeamTemplatesBackend,
    });
    await expect(beforeRestart.listTemplates.execute()).resolves.toEqual({
      status: 'recoveryInterrupted',
      storageDirectory: directory,
      markerPath,
      interruptedMarkerPath,
    });
    beforeRestart.dispose();
    await storage.dispose();

    const restarted = createInternalStorageFeature({ userDataPath: root });
    const feature = createCustomTeamTemplatesFeature({
      backend: restarted.customTeamTemplatesBackend,
    });
    const handlers = new Map<string, (_event: unknown) => unknown>();
    registerCustomTeamTemplatesIpc(
      {
        handle: (name: string, handler: (_event: unknown) => unknown) =>
          handlers.set(name, handler),
      } as unknown as IpcMain,
      feature
    );
    const http = Fastify();
    registerCustomTeamTemplatesHttp(http, feature);
    const expected = {
      status: 'recoveryInterrupted',
      storageDirectory: directory,
      markerPath,
      interruptedMarkerPath,
    };
    try {
      expect(await restarted.probeBackend()).toBe('recovery-required');
      await expect(
        Promise.resolve(handlers.get(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates)?.({}))
      ).resolves.toEqual(expected);
      const response = await http.inject({
        method: 'GET',
        url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      expect(await fs.readFile(interruptedMarkerPath, 'utf8')).toBe('interrupted');
    } finally {
      await http.close();
      feature.dispose();
      await restarted.dispose();
    }
  } finally {
    core.close();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});

it('blocks both storage backends after ping detects real database corruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'corrupt-storage-composition-'));
  const directory = path.join(root, 'storage');
  const databasePath = path.join(directory, 'app.db');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(databasePath, 'corrupt, preserve me');
  const core = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(true);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'ping').mockImplementation(
    async () => core.handle('ping', {}) as InternalStorageBackendInfo
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'customTeamTemplateList').mockImplementation(
    async () => core.handle('customTemplate.list', {}) as ListCustomTeamTemplateRecordsResult
  );
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const jsonUpdate = vi
    .spyOn(JsonTaskStallJournalStore.prototype, 'update')
    .mockImplementation(async () => {
      throw new Error('JSON write should be blocked');
    });
  const storage = createInternalStorageFeature({ userDataPath: root });
  const feature = createCustomTeamTemplatesFeature({ backend: storage.customTeamTemplatesBackend });
  try {
    expect(await storage.probeBackend()).toBe('recovery-required');
    await expect(
      storage.taskStallJournalStore.update('demo', () => ({ entries: [], result: undefined }))
    ).rejects.toThrow(/manual recovery/);
    expect(jsonUpdate).not.toHaveBeenCalled();
    await expect(feature.listTemplates.execute()).resolves.toEqual({
      status: 'recoveryRequired',
      storageDirectory: directory,
      markerPath: `${databasePath}.templates-recovery-required`,
      interruptedMarkerPath: `${databasePath}.recovery-in-progress`,
    });
    expect(await fs.readFile(databasePath, 'utf8')).toBe('corrupt, preserve me');
    expect((await fs.readdir(directory)).some((name) => name.includes('.corrupt-'))).toBe(false);
  } finally {
    feature.dispose();
    await storage.dispose();
    core.close();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});
