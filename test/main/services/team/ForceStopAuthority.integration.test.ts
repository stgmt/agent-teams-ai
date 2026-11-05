// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  readOpenCodeRuntimeLaneIdsForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
  runTeamForceStopFlow,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { expect, it, vi } from 'vitest';

const teamName = 'fixture';
const laneId = 'secondary:opencode:jack';

async function fixture() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'force-stop-authority-'));
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(scratch);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('force-stop-authority-') || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a test fixture outside its scratch parent');
  }
  const root = path.join(scratch, 'claude');
  const teamsBasePath = path.join(root, 'teams');
  setClaudeBasePathOverride(root);
  await fs.mkdir(path.join(teamsBasePath, teamName), { recursive: true });
  const store = new TeamLaunchStateStore();
  const observeRuns = vi.fn((name: string) =>
    readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName: name, teamsBasePath })
  );
  const observeLanes = vi.fn((name: string) =>
    readOpenCodeRuntimeLaneIdsForTeam(teamsBasePath, name)
  );
  const cancel = vi.fn(
    (
      name: string,
      context: {
        requestedAtMs: number;
        ownedRunIds: readonly string[];
        ownedLaneIds?: readonly string[];
      }
    ) => clearPendingOpenCodePromptDeliveriesForTeam({ teamName: name, teamsBasePath, ...context })
  );
  const kill = vi.fn(async () => ({ killedPids: [], diagnostics: [] }));
  const reap = vi.fn(async () => ({ killedPids: [], diagnostics: [] }));
  const release = vi.fn(async () => ({ diagnostics: [] }));
  const stop = vi.fn(async (_team: string, _target?: string | null) => undefined);
  const ports = {
    getStopTargetRunId: () => 'old-run',
    stopTeam: stop,
    observeOwnedRuntimeRunIds: observeRuns,
    observeOwnedRuntimeLaneIds: observeLanes,
    clearPendingPromptDeliveries: cancel,
    killRetainedRuntimeProcesses: kill,
    reapOwnedLeadProcessTrees: reap,
    releaseSharedRuntimeResources: release,
    markTeamStopped: (name: string, authority: Parameters<typeof store.markStopped>[1]) =>
      store.markStopped(name, authority),
    logWarning: () => undefined,
  };
  const successorDelivery = async (publish = true) => {
    if (publish) {
      expect(await store.beginLaunch(teamName, 'successor-run', ['jack'], () => true)).toBe(true);
    }
    await upsertOpenCodeRuntimeLaneIndexEntry({ teamsBasePath, teamName, laneId, state: 'active' });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath,
      teamName,
      laneId,
      runId: 'successor-lane-run',
    });
    const ledger = createOpenCodePromptDeliveryLedgerStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath,
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
    });
    const record = await ledger.ensurePending({
      teamName,
      memberName: 'jack',
      laneId,
      runId: 'successor-lane-run',
      inboxMessageId: 'successor-message',
      inboxTimestamp: '2026-04-25T09:59:00.000Z',
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'sha256:successor-message',
      now: '2026-04-25T10:04:00.000Z',
    });
    return { ledger, record };
  };
  const cleanup = async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  };
  return {
    store,
    ports,
    stop,
    observeRuns,
    observeLanes,
    cancel,
    kill,
    reap,
    release,
    successorDelivery,
    cleanup,
  };
}

it('does not inspect or cancel a successor when admission is already superseded', async () => {
  const f = await fixture();
  try {
    const { ledger, record } = await f.successorDelivery();
    const result = await runTeamForceStopFlow(teamName, f.ports);
    expect(result).toMatchObject({
      stopOutcome: 'stopped',
      cleanupOutcome: 'incomplete',
      clearedPendingDeliveries: 0,
    });
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(teamName, 'old-run');
    expect(f.observeRuns).not.toHaveBeenCalled();
    expect(f.observeLanes).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.reap).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect((await ledger.list()).find((item) => item.id === record.id)?.status).toBe('pending');
    expect((await f.store.read(teamName))?.publicationRunId).toBe('successor-run');
  } finally {
    await f.cleanup();
  }
});

it('does not treat missing freshness as ownership of an existing lane', async () => {
  const f = await fixture();
  try {
    const { ledger, record } = await f.successorDelivery(false);
    const result = await runTeamForceStopFlow(teamName, f.ports);
    expect(result).toMatchObject({
      stopOutcome: 'stopped',
      cleanupOutcome: 'incomplete',
      clearedPendingDeliveries: 0,
    });
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(teamName, 'old-run');
    expect(f.observeRuns).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.reap).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect((await ledger.list()).find((item) => item.id === record.id)?.status).toBe('pending');
    expect(await f.store.isStopped(teamName)).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it('skips the late cleanup if a successor is published while the old stop is running', async () => {
  const f = await fixture();
  let finish!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    expect(await f.store.beginLaunch(teamName, 'old-run', ['jack'], () => true)).toBe(true);
    f.stop.mockImplementation(async () => {
      entered();
      await waiting;
    });
    const stopping = runTeamForceStopFlow(teamName, f.ports);
    await started;
    const { ledger, record } = await f.successorDelivery();
    finish();
    const result = await stopping;
    expect(result).toMatchObject({ stopOutcome: 'stopped', cleanupOutcome: 'incomplete' });
    expect(f.cancel).toHaveBeenCalledOnce(); // only the pre-stop, old-run scope
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.reap).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect((await ledger.list()).find((item) => item.id === record.id)?.status).toBe('pending');
    expect((await f.store.read(teamName))?.publicationRunId).toBe('successor-run');
  } finally {
    finish();
    await f.cleanup();
  }
});
