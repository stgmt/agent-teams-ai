import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { TeamMetaStore } from '@main/services/team/TeamMetaStore';

const requireFromTest = createRequire(import.meta.url);
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registryRegistrationWorker.ts');

function startWorker(base: string, workerId: string, project: string, securityStoreId = 'store-1') {
  const child = spawn(process.execPath, [
    requireFromTest.resolve('tsx/cli'), fixture, base, workerId, project, securityStoreId,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}

async function waitForReady(
  base: string,
  workers: readonly { child: { exitCode: number | null; signalCode: NodeJS.Signals | null } }[]
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (workers.some(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('Registration worker exited before the start barrier');
    }
    const ready = await Promise.all(['a', 'b'].map(async (id) => {
      try {
        await fs.access(path.join(base, `ready-${id}`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }));
    if (ready.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Registration workers did not reach the start barrier');
}

describe('durable registry registration preparation', () => {
  let base = '';
  afterEach(async () => {
    if (base) await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    base = '';
  });

  it('reuses one persisted request across concurrent callers and store instances', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'team-registration-'));
    await fs.mkdir(path.join(base, 'team'));
    const first = new TeamMetaStore();
    const second = new TeamMetaStore();
    await first.writeMeta('team', { cwd: '', createdAt: 1 }, base);
    const [a, b] = await Promise.all([
      first.prepareRegistryRegistration('team', 'owner/project', base),
      second.prepareRegistryRegistration('team', 'owner/project', base),
    ]);
    expect(a.requestId).toBeTruthy();
    expect(b).toEqual(a);
    expect(await new TeamMetaStore().getMeta('team', base)).toMatchObject({
      registryRegistrationRequestId: a.requestId,
      registryRegistrationProject: 'owner/project',
      registryRegistrationCompleted: false,
    });
    await expect(second.prepareRegistryRegistration('team', 'other/project', base)).rejects.toThrow();
    await expect(second.updateMeta('team', (current) => ({ ...current!, cwd: '', createdAt: 1, registryRegistrationRequestId: 'other' }), base)).rejects.toThrow('Cannot change durable');
  });

  it('fences registration across simultaneously released Node processes', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'team-registration-process-'));
    await fs.mkdir(path.join(base, 'team'));
    const store = new TeamMetaStore();
    await store.writeMeta('team', { cwd: '', createdAt: 1, displayName: 'Original' }, base);
    const workers = [startWorker(base, 'a', 'owner/project'), startWorker(base, 'b', 'owner/project')];
    try {
      await waitForReady(base, workers);
      await fs.writeFile(path.join(base, 'go'), 'go', { flag: 'wx' });
      const results = await Promise.all(workers.map((worker) => worker.result));
      expect(results.map((result) => result.code)).toEqual([0, 0]);
      const registrations = results.map((result) => JSON.parse(result.stdout) as { requestId: string; project: string });
      expect(registrations[0].requestId).toBeTruthy();
      expect(registrations[1]).toEqual(registrations[0]);
      expect(await store.getMeta('team', base, { requireCompleteFields: true })).toMatchObject({
        displayName: 'Original',
        registryRegistrationRequestId: registrations[0].requestId,
        registryRegistrationProject: 'owner/project',
        registryRegistrationIdentity: { securityStoreId: 'store-1', idp: 'idp-1', userId: 'user-1' },
      });
      const other = startWorker(base, 'other', 'other/project');
      workers.push(other);
      const rejected = await other.result;
      expect(rejected.code).not.toBe(0);
      const changedStore = startWorker(base, 'changed-store', 'owner/project', 'store-2');
      workers.push(changedStore);
      const identityRejected = await changedStore.result;
      expect(identityRejected.code).not.toBe(0);
      expect(identityRejected.stderr).toContain('identity mismatch');
      expect(rejected.stderr).toContain('project');
      expect(await store.getMeta('team', base, { requireCompleteFields: true })).toMatchObject({
        registryRegistrationRequestId: registrations[0].requestId,
        registryRegistrationProject: 'owner/project',
      });
    } finally {
      for (const worker of workers) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill();
      }
      await Promise.allSettled(workers.map((worker) => worker.result));
    }
  }, 60_000);

  it('refuses to reserve for missing or corrupt metadata', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'team-registration-'));
    await fs.mkdir(path.join(base, 'team'));
    const store = new TeamMetaStore();
    await expect(store.prepareRegistryRegistration('team', 'owner/project', base)).rejects.toThrow();
    await fs.writeFile(path.join(base, 'team', 'team.meta.json'), '{');
    await expect(store.prepareRegistryRegistration('team', 'owner/project', base)).rejects.toThrow();
  });
});
