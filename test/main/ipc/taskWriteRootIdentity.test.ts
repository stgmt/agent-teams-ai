import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertTaskWriteRootFingerprint,
  getTaskWriteRootFingerprint,
} from '@features/external-agent-connection/main/taskWriteRootIdentity';
import { createIpcContextCallbacks } from '@main/createIpcContextCallbacks';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('physical task write root identity', () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const dir of temporary.splice(0))
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('shares identity across a directory and its junction and rejects stale or missing roots', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'TEST-task-root-'));
    temporary.push(dir);
    const root = path.join(dir, 'real-root');
    const alias = path.join(dir, 'alias-root');
    const other = path.join(dir, 'other-root');
    mkdirSync(root);
    mkdirSync(other);
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const fingerprint = getTaskWriteRootFingerprint(root);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(getTaskWriteRootFingerprint(alias)).toBe(fingerprint);
    if (process.platform === 'win32')
      expect(getTaskWriteRootFingerprint(root.toUpperCase())).toBe(fingerprint);
    expect(getTaskWriteRootFingerprint(other)).not.toBe(fingerprint);
    expect(getTaskWriteRootFingerprint(path.join(dir, 'missing'))).toBeNull();
    expect(() => assertTaskWriteRootFingerprint(other, fingerprint)).toThrow(/root/);

    const context = {
      appInstanceId: 'TEST-app',
      dataRootFingerprint: 'a'.repeat(64),
      connectionGeneration: 1,
    };
    const connection = {
      withExpectedContext: vi.fn(async (_context: unknown, operation: () => Promise<unknown>) =>
        operation()
      ),
    };
    let selectedRoot = alias;
    const callbacks = createIpcContextCallbacks({
      rewire: vi.fn(),
      full: vi.fn(),
      connection: () => connection as never,
      getTaskWriteRoot: () => selectedRoot,
      notifyLanguageChange: vi.fn(),
    });
    const operation = vi.fn(async () => 'done');
    await expect(
      callbacks.withExpectedTaskWriteContext(context, fingerprint!, operation)
    ).resolves.toBe('done');
    selectedRoot = other;
    await expect(
      callbacks.withExpectedTaskWriteContext(context, fingerprint!, operation)
    ).rejects.toThrow(/root/);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
