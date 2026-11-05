// @vitest-environment node
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

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

import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';
import type { IpcMain } from 'electron';

const run = promisify(execFile);
async function cleanup(root: string): Promise<void> {
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(root);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('storage-unavailable-composition-') || relative.includes(path.sep))
    throw new Error('Refusing to remove a path outside the test scratch parent');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

it.each([
  ['an existing unverified database', true, 'storageVerificationRequired'],
  ['a new profile without database files', false, 'storageSafetyUnavailable'],
] as const)(
  'reports %s over IPC and HTTP when the worker is unavailable',
  async (_label, existing, status) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-unavailable-composition-'));
    const directory = path.join(root, 'storage');
    const databasePath = path.join(directory, 'app.db');
    if (existing) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(databasePath, 'unverified; preserve');
    }
    vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(false);
    vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
    const storage = createInternalStorageFeature({ userDataPath: root });
    const feature = createCustomTeamTemplatesFeature({
      backend: storage.customTeamTemplatesBackend,
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
    try {
      expect(await storage.probeBackend()).toBe('verification-required');
      const expected = { status, storageDirectory: directory, databasePath };
      expect(await handlers.get(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates)?.({})).toEqual(
        expected
      );
      const response = await http.inject({
        method: 'GET',
        url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expected);
      await expect(
        storage.taskCommentNotificationJournalStore.ensureInitialized('demo')
      ).rejects.toThrow(/JSON fallback is disabled/);
      await expect(
        storage.memberWorkSyncBackend!.selector.select('sqlite', 'json')
      ).rejects.toThrow(/JSON fallback is disabled/);
      if (existing) expect(await fs.readFile(databasePath, 'utf8')).toBe('unverified; preserve');
      else await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await http.close();
      feature.dispose();
      await storage.dispose();
      vi.restoreAllMocks();
      await cleanup(root);
    }
  }
);

it('keeps a selected SQLite backend and diagnoses a later worker failure without a JSON write', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-unavailable-composition-'));
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
  const list = vi
    .spyOn(InternalStorageWorkerClient.prototype, 'customTeamTemplateList')
    .mockRejectedValue(new Error('worker stopped after SQLite selection'));
  const sqliteWrite = vi
    .spyOn(SqliteTaskStallJournalStore.prototype, 'update')
    .mockRejectedValue(new Error('worker stopped after SQLite selection'));
  const jsonWrite = vi.spyOn(JsonTaskStallJournalStore.prototype, 'update');
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
    expect(await storage.probeBackend()).toBe('sqlite');
    const expected = {
      status: 'storageVerificationRequired',
      storageDirectory: path.dirname(databasePath),
      databasePath,
    };
    expect(await handlers.get(CUSTOM_TEAM_TEMPLATE_CHANNELS.listTemplates)?.({})).toEqual(expected);
    const response = await http.inject({
      method: 'GET',
      url: CUSTOM_TEAM_TEMPLATE_ROUTES.listTemplates,
    });
    expect(response.json()).toEqual(expected);
    expect(list).toHaveBeenCalledTimes(2);
    await expect(
      storage.taskStallJournalStore.update('demo', (entries) => ({ entries, result: undefined }))
    ).rejects.toThrow('worker stopped after SQLite selection');
    expect(sqliteWrite).toHaveBeenCalledTimes(1);
    expect(jsonWrite).not.toHaveBeenCalled();
    expect(storage.getBackendKind()).toBe('sqlite');
  } finally {
    await http.close();
    feature.dispose();
    await storage.dispose();
    core.close();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});

it('does not start a JSON write while another process creates and writes SQLite', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-unavailable-composition-'));
  const databasePath = path.join(root, 'storage', 'app.db');
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(false);
  vi.spyOn(InternalStorageWorkerClient.prototype, 'close').mockResolvedValue(undefined);
  const jsonWrite = vi.spyOn(JsonTaskStallJournalStore.prototype, 'update');
  const feature = createInternalStorageFeature({ userDataPath: root });
  try {
    const blocked = feature.taskStallJournalStore.update('demo', (entries) => ({
      entries,
      result: 'json-committed',
    }));
    const child = run(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('test/fixtures/internalStorageFallbackRaceWorker.ts'),
        databasePath,
      ],
      { cwd: process.cwd(), timeout: 30000 }
    );
    await expect(blocked).rejects.toThrow(/JSON fallback is disabled/);
    expect((await child).stdout).toContain('sqlite-committed');
    expect(jsonWrite).not.toHaveBeenCalled();
    const core = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    try {
      expect(core.handle('stallJournal.load', { teamName: 'demo' })).toMatchObject([
        { epochKey: 'sqlite-entry' },
      ]);
    } finally {
      core.close();
    }
  } finally {
    await feature.dispose();
    vi.restoreAllMocks();
    await cleanup(root);
  }
});
