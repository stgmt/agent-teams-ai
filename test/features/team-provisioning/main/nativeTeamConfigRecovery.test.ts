// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeNativeTeamConfig } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeTeamConfig';
import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';

const run = {
  appInstanceId: 'TEST-old-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 20 }))
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-config-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  await mkdir(join(teamsRoot, 'test-team'), { recursive: true });
  const store = new NativeTeamConfigStore(teamsRoot);
  await store.mutate('test-team', new AbortController().signal, async () => ({
    name: 'test-team',
    appManagedRun: { identity: run, configurationRevision: 'TEST-revision' },
  }));
  const invalidate = vi.fn();
  const config = new NodeNativeTeamConfig({
    teamsRoot,
    settings: {} as never,
    invalidate,
  });
  const readClaim = async (): Promise<unknown> => {
    const parsed = JSON.parse(
      await readFile(join(teamsRoot, 'test-team', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    return parsed.appManagedRun;
  };
  return { config, invalidate, readClaim, teamsRoot, store };
}

describe('native team config recovery', () => {
  it('keeps the claim while the run is alive and clears it when it is not', async () => {
    const { config, invalidate, readClaim } = await setup();
    await expect(config.recoverOrphanedClaim('test-team', () => true)).resolves.toBe(false);
    await expect(readClaim()).resolves.toMatchObject({ identity: run });
    expect(invalidate).not.toHaveBeenCalled();

    await expect(config.recoverOrphanedClaim('test-team', () => false)).resolves.toBe(true);
    await expect(readClaim()).resolves.toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith('test-team');
  });

  it('releases process rows whose recorded PID is gone, and keeps a live one', async () => {
    const { config, store, teamsRoot } = await setup();
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid ?? 0));
    });
    await store.mutate('test-team', new AbortController().signal, async (current) => ({
      ...current,
      members: [
        {
          name: 'team-lead',
          runtimePid: deadPid,
          runtimeProcessBirthId: 'TEST-birth',
          runtimeOperationId: 'TEST-operation',
          tmuxPaneId: `process:${deadPid}`,
        },
        {
          name: 'builder',
          runtimePid: process.pid,
          runtimeProcessBirthId: 'TEST-live-birth',
          runtimeOperationId: 'TEST-live-operation',
        },
      ],
    }));

    await expect(config.recoverOrphanedClaim('test-team', () => false)).resolves.toBe(true);
    const after = JSON.parse(await readFile(join(teamsRoot, 'test-team', 'config.json'), 'utf8')) as {
      members: Record<string, unknown>[];
    };
    const byName = Object.fromEntries(after.members.map((member) => [member.name, member]));
    expect(byName['team-lead']?.runtimePid).toBeUndefined();
    expect(byName['team-lead']?.runtimeProcessBirthId).toBeUndefined();
    expect(byName['team-lead']?.tmuxPaneId).toBeUndefined();
    // A live process keeps its row; recovery never kills anything.
    expect(byName.builder?.runtimePid).toBe(process.pid);
    expect(byName.builder?.runtimeProcessBirthId).toBe('TEST-live-birth');
  });

  it('clears the claim once and is idempotent', async () => {
    const { config, invalidate } = await setup();
    await config.recoverOrphanedClaim('test-team', () => false);
    await expect(config.recoverOrphanedClaim('test-team', () => false)).resolves.toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
