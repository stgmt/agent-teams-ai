import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_FENCE_DECISION,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../../contracts';
import { FileVerifiedActionStore } from '../infrastructure/FileVerifiedActionStore';

import { registerVerifiedActionIpc } from './registerVerifiedActionIpc';

import type { IpcMain } from 'electron';

const paths = vi.hoisted(() => ({ appData: '', claude: '' }));
vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: () => paths.appData,
  getClaudeBasePath: () => paths.claude,
}));

const roots: string[] = [];
afterEach(async () => {
  const parent = await fs.promises.realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    const resolved = await fs.promises.realpath(root);
    const relative = path.relative(parent, resolved);
    if (!relative.startsWith('verified-action-ipc-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a test fixture outside its scratch parent');
    }
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});

describe('verified-action IPC context boundary', () => {
  it('rejects remote and stale contexts before reading or changing local actions', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-action-ipc-'));
    roots.push(root);
    paths.appData = root;
    paths.claude = path.join(root, 'claude');
    let active = 'local';
    let local = true;
    const expected = {
      appInstanceId: 'app',
      dataRootFingerprint: 'a'.repeat(64),
      connectionGeneration: 1,
    };
    const rootFingerprint = 'b'.repeat(64);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as IpcMain;
    registerVerifiedActionIpc(ipc, {
      getActiveContextId: () => active,
      isLocal: () => local,
      getRootFingerprint: () => rootFingerprint,
      withAdmission: (_expected, _root, operation) => operation(),
    });
    const list = handlers.get(VERIFIED_ACTION_LIST)!;
    const prepare = handlers.get(VERIFIED_ACTION_PREPARE)!;
    const approve = handlers.get(VERIFIED_ACTION_APPROVE)!;
    expect(await list({}, 'local', expected, rootFingerprint, 'team', 'task')).toEqual([]);
    active = 'ssh:host';
    local = false;
    expect(() => list({}, 'ssh:host', expected, rootFingerprint, 'team', 'task')).toThrow(
      /active local context/
    );
    expect(() => prepare({}, 'local', expected, rootFingerprint, 'team', 'task')).toThrow(
      /active local context/
    );
    expect(() => approve({}, 'local', expected, rootFingerprint, 'a'.repeat(64))).toThrow(
      /active local context/
    );
    active = 'local';
    expect(() => list({}, 'local', expected, rootFingerprint, 'team', 'task')).toThrow(
      /active local context/
    );
    local = true;
    expect(() => list({}, 'ssh:host', expected, rootFingerprint, 'team', 'task')).toThrow(
      /active local context/
    );
    expect(() => list({}, 'local', null, rootFingerprint, 'team', 'task')).toThrow(
      /Expected app context/
    );
    expect(() => list({}, 'local', expected, 'c'.repeat(64), 'team', 'task')).toThrow(
      /root identity changed/
    );
  });

  it('does not apply a claimed fence to a switched root or stale generation', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-action-ipc-'));
    roots.push(root);
    paths.appData = root;
    paths.claude = path.join(root, 'claude');
    const bound = new BoundControlContext('test-app', paths.claude);
    const expected = bound.snapshot();
    let activeRoot = 'b'.repeat(64);
    const previousRoot = activeRoot;
    const actionId = 'a'.repeat(64);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const store = new FileVerifiedActionStore(path.join(root, 'verified-actions'));
    await store.transaction(async (tx) =>
      tx.write([
        {
          id: actionId,
          scope: previousRoot,
          teamName: 'team',
          taskId: 'task',
          proof: { attachmentId: 'report', sha256: 'c'.repeat(64), size: 23 },
          status: 'question',
          attempts: 1,
          createdAt: 'now',
          updatedAt: 'now',
        },
      ])
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as IpcMain;
    registerVerifiedActionIpc(ipc, {
      getActiveContextId: () => 'local',
      isLocal: () => true,
      getRootFingerprint: () => activeRoot,
      withAdmission: async (context, _root, operation) => {
        const release = bound.admit(context);
        try {
          return await operation();
        } finally {
          release();
        }
      },
    });
    const fence = handlers.get(VERIFIED_ACTION_FENCE_DECISION)!;
    await bound.closeAdmission();
    bound.rebind(path.join(root, 'other'));
    activeRoot = 'd'.repeat(64);
    await expect(
      fence({}, 'local', expected, previousRoot, actionId, 'retry_once', decisionId)
    ).resolves.toEqual({ outcome: 'not_admitted' });
    await bound.closeAdmission();
    bound.rebind(paths.claude);
    activeRoot = previousRoot;
    await expect(
      fence({}, 'local', expected, previousRoot, actionId, 'retry_once', decisionId)
    ).resolves.toEqual({ outcome: 'not_admitted' });
    // Once the service callback is entered, failures remain ambiguous and
    // must not be downgraded to a proven pre-admission rejection.
    await expect(
      fence({}, 'local', bound.snapshot(), previousRoot, 'e'.repeat(64), 'retry_once', decisionId)
    ).rejects.toThrow();
    const stored = await store.transaction(async (tx) => tx.read());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: actionId, status: 'question' });
    expect(stored[0].decisionReceipt).toBeUndefined();
  });

  it('holds context admission while waiting for the file lock and until the read finishes', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-action-ipc-'));
    roots.push(root);
    paths.appData = root;
    paths.claude = path.join(root, 'claude');
    const store = new FileVerifiedActionStore(path.join(root, 'verified-actions'));
    const bound = new BoundControlContext('test-app', paths.claude);
    const rootFingerprint = 'b'.repeat(64);
    let releaseLock!: () => void;
    let locked!: () => void;
    const lockedSignal = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = store.transaction(async () => {
      locked();
      await lockGate;
    });
    await lockedSignal;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    } as unknown as IpcMain;
    registerVerifiedActionIpc(ipc, {
      getActiveContextId: () => 'local',
      isLocal: () => true,
      getRootFingerprint: () => rootFingerprint,
      withAdmission: async (expected, _root, operation) => {
        const release = bound.admit(expected);
        try {
          return await operation();
        } finally {
          release();
        }
      },
    });
    const expected = bound.snapshot();
    const request = handlers.get(VERIFIED_ACTION_LIST)!(
      {},
      'local',
      expected,
      rootFingerprint,
      'team',
      'task'
    ) as Promise<unknown>;
    let closed = false;
    const close = bound.closeAdmission().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseLock();
    await holder;
    expect(await request).toEqual([]);
    await close;
    expect(closed).toBe(true);
    await expect(
      handlers.get(VERIFIED_ACTION_LIST)!({}, 'local', expected, rootFingerprint, 'team', 'task')
    ).rejects.toThrow(/APP_CONTEXT_MISMATCH/);
  });
});
