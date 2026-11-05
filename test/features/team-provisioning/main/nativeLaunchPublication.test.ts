// @vitest-environment node
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { NativeLaunchPublication } from '@features/team-provisioning/main/adapters/output/NativeLaunchPublication';
import { createNativeOpenCodeRuntimePidMemory } from '@features/team-provisioning/main/adapters/output/NativeOpenCodeRuntimePidMemory';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { readTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const teamName = 'fixture';
const run = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
  teamName,
  runId: 'old-run',
};
let target: string;
let teamsRoot: string;
const rawFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

beforeEach(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'native-launch-publication-'));
  const parent = await fs.realpath(os.tmpdir());
  target = await fs.realpath(scratch);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('native-launch-publication-') || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a test fixture outside its scratch parent');
  }
  teamsRoot = path.join(target, 'teams');
  await fs.mkdir(path.join(teamsRoot, teamName), { recursive: true });
});
afterEach(async () => {
  setClaudeBasePathOverride(null);
  await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

describe('native launch publication', () => {
  it('accepts a snapshot and bridge PID only for the current native run', async () => {
    setClaudeBasePathOverride(target);
    const store = new TeamLaunchStateStore(teamsRoot);
    await store.beginNativeLaunch(teamName, run.runId, () => true);
    const snapshot = createPersistedLaunchSnapshot({
      teamName,
      expectedMembers: ['dev'],
      members: {
        dev: {
          name: 'dev',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-11-06T00:00:00.000Z',
          laneId: 'primary',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          providerId: 'opencode',
          runtimeRunId: run.runId,
        },
      },
    });
    expect(await store.write(teamName, snapshot, { runId: run.runId })).toBe(true);
    expect(await store.readResult(teamName)).toMatchObject({
      status: 'snapshot',
      snapshot: { publicationRunId: run.runId },
    });
    const emit = vi.fn();
    const bridge = createNativeOpenCodeRuntimePidMemory({
      store,
      invalidateRuntimeSnapshotCaches: vi.fn(),
      emitTeamChange: emit,
      logDebug: vi.fn(),
      readProcessCommand: () => 'opencode serve --port 4444',
    });
    await bridge.rememberRuntimePidFromBridge({
      teamName,
      memberName: 'dev',
      laneId: 'primary',
      runId: run.runId,
      runtimePid: 4242,
      reason: 'bridge_launch',
    });
    const persisted = JSON.parse(
      await fs.readFile(path.join(teamsRoot, teamName, 'launch-state.json'), 'utf8')
    );
    expect(persisted.members.dev.runtimePid).toBe(4242);
    expect(emit).toHaveBeenCalledOnce();
  });
  it('does not expose a previous bootstrap state as the native run status', async () => {
    const directory = path.join(teamsRoot, teamName);
    await fs.writeFile(
      path.join(directory, 'config.json'),
      JSON.stringify({ name: teamName, members: [{ name: 'team-lead', agentType: 'team-lead' }] })
    );
    await fs.writeFile(
      path.join(directory, 'bootstrap-state.json'),
      JSON.stringify({
        version: 1,
        teamName,
        runId: 'legacy-run',
        ownerPid: process.pid,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'pending' }],
      })
    );
    setClaudeBasePathOverride(target);
    const publisher = new NativeLaunchPublication(teamsRoot);
    await publisher.begin(run, ['lead'], new AbortController().signal);
    const team = (await new TeamConfigReader().listTeams()).find(
      (entry) => entry.teamName === teamName
    );
    expect(team).toBeDefined();
    expect(team?.teamLaunchState).not.toBe('partial_pending');
    expect(await fs.readFile(path.join(directory, 'bootstrap-state.json'), 'utf8')).toContain(
      'legacy-run'
    );
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'stop',
      stoppedRunId: run.runId,
      native: true,
    });
    const afterRestart = (await new TeamConfigReader().listTeams()).find(
      (entry) => entry.teamName === teamName
    );
    expect(afterRestart?.teamLaunchState).not.toBe('partial_pending');
    expect(await fs.readFile(path.join(directory, 'bootstrap-state.json'), 'utf8')).toContain(
      'legacy-run'
    );
    const successor = new TeamLaunchStateStore(teamsRoot);
    expect(await successor.beginLaunch(teamName, 'next-legacy-run', ['lead'], () => true)).toBe(
      true
    );
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toEqual({
      version: 1,
      teamName,
      kind: 'launch',
      runId: 'next-legacy-run',
    });
    expect(await successor.readResult(teamName)).toMatchObject({
      status: 'snapshot',
      snapshot: { publicationRunId: 'next-legacy-run' },
    });
  });
  it('publishes ownership without inventing status or removing earlier snapshots', async () => {
    const directory = path.join(teamsRoot, teamName);
    await fs.writeFile(path.join(directory, 'launch-state.json'), '{"publicationRunId":"older"}');
    await fs.writeFile(path.join(directory, 'launch-summary.json'), '{"publicationRunId":"older"}');
    const publisher = new NativeLaunchPublication(teamsRoot);
    await publisher.begin(run, ['lead'], new AbortController().signal);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'launch',
      runId: run.runId,
    });
    expect(await fs.readFile(path.join(directory, 'launch-state.json'), 'utf8')).toContain('older');
    expect(await fs.readFile(path.join(directory, 'launch-summary.json'), 'utf8')).toContain(
      'older'
    );
    expect((await new TeamLaunchStateStore(teamsRoot).readResult(teamName)).status).toBe(
      'unreadable'
    );
    await publisher.retire(run);
    expect(await fs.readFile(path.join(directory, 'launch-state.json'), 'utf8')).toContain('older');
    expect(await fs.readFile(path.join(directory, 'launch-summary.json'), 'utf8')).toContain(
      'older'
    );
  });

  it.each(['before', 'after'] as const)(
    'preserves the previous snapshot if native authority fails %s rename',
    async (stage) => {
      const store = new TeamLaunchStateStore(teamsRoot);
      expect(await store.beginLaunch(teamName, 'legacy-run', ['lead'], () => true)).toBe(true);
      const previous = await store.readResult(teamName);
      const priorFreshness = await readTeamLaunchFreshness(teamName, teamsRoot);
      const rename = rawFs.promises.rename.bind(rawFs.promises);
      const spy = vi
        .spyOn(rawFs.promises, 'rename')
        .mockImplementation(async (source, destination) => {
          if (String(destination) === path.join(teamsRoot, teamName, 'launch-freshness.json')) {
            if (stage === 'after') await rename(source, destination);
            throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
          }
          return rename(source, destination);
        });
      try {
        await expect(store.beginNativeLaunch(teamName, run.runId, () => true)).rejects.toThrow(
          'injected EIO'
        );
      } finally {
        spy.mockRestore();
      }
      expect(
        JSON.parse(await fs.readFile(path.join(teamsRoot, teamName, 'launch-state.json'), 'utf8'))
          .publicationRunId
      ).toBe('legacy-run');
      expect(
        JSON.parse(await fs.readFile(path.join(teamsRoot, teamName, 'launch-summary.json'), 'utf8'))
          .publicationRunId
      ).toBe('legacy-run');
      if (stage === 'before') {
        expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toEqual(priorFreshness);
        expect(await store.readResult(teamName)).toEqual(previous);
      } else {
        expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
          kind: 'launch',
          runId: run.runId,
          native: true,
        });
        expect((await store.readResult(teamName)).status).toBe('unreadable');
      }
    }
  );

  it.each(['before', 'after'] as const)(
    'keeps historical snapshots fenced when native stop fails %s rename',
    async (stage) => {
      const store = new TeamLaunchStateStore(teamsRoot);
      await store.beginLaunch(teamName, 'legacy-run', ['lead'], () => true);
      const publisher = new NativeLaunchPublication(teamsRoot);
      await publisher.begin(run, ['lead'], new AbortController().signal);
      const rename = rawFs.promises.rename.bind(rawFs.promises);
      const spy = vi
        .spyOn(rawFs.promises, 'rename')
        .mockImplementation(async (source, destination) => {
          if (String(destination) === path.join(teamsRoot, teamName, 'launch-freshness.json')) {
            if (stage === 'after') await rename(source, destination);
            throw Object.assign(new Error('stop EIO'), { code: 'EIO' });
          }
          return rename(source, destination);
        });
      try {
        await expect(publisher.retire(run)).rejects.toThrow('stop EIO');
      } finally {
        spy.mockRestore();
      }
      const freshness = await readTeamLaunchFreshness(teamName, teamsRoot);
      expect(freshness).toMatchObject({
        kind: stage === 'before' ? 'launch' : 'stop',
        native: true,
      });
      expect((await new TeamLaunchStateStore(teamsRoot).readResult(teamName)).status).toBe(
        'unreadable'
      );
      expect(
        JSON.parse(await fs.readFile(path.join(teamsRoot, teamName, 'launch-state.json'), 'utf8'))
          .publicationRunId
      ).toBe('legacy-run');
      expect(
        JSON.parse(await fs.readFile(path.join(teamsRoot, teamName, 'launch-summary.json'), 'utf8'))
          .publicationRunId
      ).toBe('legacy-run');
    }
  );

  it('does not publish an aborted preparation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      new NativeLaunchPublication(teamsRoot).begin(run, ['lead'], abort.signal)
    ).rejects.toThrow();
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toBeNull();
  });
  it('publishes under the lifecycle root and retires that same run on release', async () => {
    const publisher = new NativeLaunchPublication(teamsRoot);
    await publisher.begin(run, ['lead'], new AbortController().signal);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'launch',
      runId: run.runId,
    });
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'stop',
      stoppedRunId: run.runId,
    });
    expect(await new TeamLaunchStateStore(teamsRoot).isStopped(teamName)).toBe(true);
  });

  it('retiring a failed or aborted preparation preserves a newer publication', async () => {
    const publisher = new NativeLaunchPublication(teamsRoot);
    const abort = new AbortController();
    await publisher.begin(run, ['lead'], abort.signal);
    expect(
      await new TeamLaunchStateStore(teamsRoot).beginLaunch(
        teamName,
        'successor',
        ['lead'],
        () => true
      )
    ).toBe(true);
    abort.abort();
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'launch',
      runId: 'successor',
    });
    expect(await new TeamLaunchStateStore(teamsRoot).isStopped(teamName)).toBe(false);
  });

  it('does not supersede an already admitted Stop during release', async () => {
    const publisher = new NativeLaunchPublication(teamsRoot);
    await publisher.begin(run, ['lead'], new AbortController().signal);
    const store = new TeamLaunchStateStore(teamsRoot);
    const stop = await store.beginStop(teamName, run.runId);
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'launch',
      runId: run.runId,
    });
    expect(await store.markStopped(teamName, stop)).toBe(true);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'stop',
      stoppedRunId: run.runId,
    });
  });

  it.each(['old-run', null] as const)(
    'does not revoke a native owner for a mismatched Stop target %s',
    async (targetRunId) => {
      const successor = { ...run, runId: 'successor-run' };
      const publisher = new NativeLaunchPublication(teamsRoot);
      await publisher.begin(successor, ['lead'], new AbortController().signal);

      await expect(
        new TeamLaunchStateStore(teamsRoot).beginStop(teamName, targetRunId)
      ).rejects.toThrow('Stop publication authority was superseded');
      await publisher.retire(successor);
      expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
        kind: 'stop',
        stoppedRunId: successor.runId,
      });
    }
  );

  it('retiring an aborted preparation finishes its own publication', async () => {
    const publisher = new NativeLaunchPublication(teamsRoot);
    const abort = new AbortController();
    await publisher.begin(run, ['lead'], abort.signal);
    abort.abort();
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'stop',
      stoppedRunId: run.runId,
    });
  });

  it('does not let a Stop in a sibling teams root revoke this owner', async () => {
    const siblingRoot = path.join(target, 'other-teams');
    await fs.mkdir(path.join(siblingRoot, teamName), { recursive: true });
    const local = new NativeLaunchPublication(teamsRoot);
    const sibling = new NativeLaunchPublication(siblingRoot);
    await local.begin(run, ['lead'], new AbortController().signal);
    await sibling.begin(run, ['lead'], new AbortController().signal);

    const localStore = new TeamLaunchStateStore(teamsRoot);
    const stop = await localStore.beginStop(teamName, run.runId);
    await sibling.retire(run);

    expect(await readTeamLaunchFreshness(teamName, siblingRoot)).toMatchObject({
      kind: 'stop',
      stoppedRunId: run.runId,
    });
    expect(await localStore.markStopped(teamName, stop)).toBe(true);
  });

  it('treats a junction and Windows path casing as the same teams root', async () => {
    const aliasParent = path.join(target, 'alias-parent');
    const aliasRoot = path.join(aliasParent, 'teams');
    await fs.mkdir(aliasParent);
    await fs.symlink(teamsRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const publisher = new NativeLaunchPublication(teamsRoot);
    await publisher.begin(run, ['lead'], new AbortController().signal);

    const aliasStore = new TeamLaunchStateStore(
      process.platform === 'win32' ? aliasRoot.toUpperCase() : aliasRoot
    );
    const stop = await aliasStore.beginStop(teamName, run.runId);
    await publisher.retire(run);
    expect(await readTeamLaunchFreshness(teamName, teamsRoot)).toMatchObject({
      kind: 'launch',
      runId: run.runId,
    });
    expect(await aliasStore.markStopped(teamName, stop)).toBe(true);
  });
});
