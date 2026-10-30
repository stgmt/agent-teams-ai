// @vitest-environment node
import { mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeRuntimeConnection } from '../../../../src/features/team-provisioning/main/adapters/output/NativeRuntimeConnection';

const directories: string[] = [];
const subscriptions: (() => void)[] = [];
const expected = {
  teamName: 'TEST-team',
  memberName: 'builder',
  runId: 'TEST-run',
  proofToken: 'TEST-proof',
  contextHash: 'TEST-context',
  briefingHash: 'TEST-briefing',
  boundaryMs: Date.now() - 1000,
};
const processIdentity = { pid: process.pid, birthId: 'TEST-birth' };

function proof(patch: Record<string, unknown> = {}) {
  return (
    JSON.stringify({
      version: 1,
      type: 'bootstrap_confirmed',
      timestamp: new Date().toISOString(),
      pid: processIdentity.pid,
      teamName: expected.teamName,
      agentName: expected.memberName,
      runId: expected.runId,
      bootstrapRunId: expected.runId,
      source: 'native_app_managed_bootstrap_private_turn',
      bootstrapProofToken: expected.proofToken,
      contextHash: expected.contextHash,
      briefingHash: expected.briefingHash,
      ...patch,
    }) + '\n'
  );
}

async function setup(initial = '') {
  const directory = await mkdtemp(join(tmpdir(), 'TEST-native-runtime-connection-'));
  directories.push(directory);
  const eventsPath = join(directory, 'events.jsonl');
  await writeFile(eventsPath, initial);
  const connected = vi.fn();
  const failed = vi.fn();
  const source = new NativeRuntimeConnection({ eventsPath, ...expected });
  subscriptions.push(source.subscribe(processIdentity, { connected, failed }));
  return { eventsPath, connected, failed, source };
}

afterEach(async () => {
  subscriptions.splice(0).forEach((dispose) => dispose());
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      })
    )
  );
});

describe('native runtime connection evidence from the exact owned attempt', () => {
  it('catches up proof written before subscription and observes it once', async () => {
    const { connected, failed } = await setup(proof());
    await expect.poll(() => connected.mock.calls.length).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('rejects old, foreign, wrong-process and incomplete proofs, including historical briefing success', async () => {
    const invalid = [
      { pid: processIdentity.pid + 1 },
      { teamName: 'foreign' },
      { agentName: 'other' },
      { runId: 'old' },
      { bootstrapRunId: 'old' },
      { bootstrapProofToken: 'old' },
      { contextHash: 'old' },
      { briefingHash: 'old' },
      { version: 2 },
      { timestamp: new Date(expected.boundaryMs - 1).toISOString() },
      { source: 'member_briefing_tool_success' },
      { type: 'heartbeat' },
    ];
    const { eventsPath, connected, failed } = await setup(invalid.map(proof).join(''));
    await appendFile(eventsPath, proof());
    await expect.poll(() => connected.mock.calls.length).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('reports a current native bootstrap failure without waiting forever for readiness', async () => {
    const { eventsPath, connected, failed } = await setup();
    await appendFile(
      eventsPath,
      proof({ type: 'failed', runId: 'old', bootstrapRunId: 'old', detail: 'TEST stale failure' })
    );
    await appendFile(eventsPath, proof({ type: 'failed', detail: 'TEST native bootstrap failed' }));
    await expect.poll(() => failed.mock.calls.length).toBe(1);
    expect(failed.mock.calls[0][0].message).toBe('TEST native bootstrap failed');
    expect(connected).not.toHaveBeenCalled();
  });

  it('fails closed on an owned child context-load error emitted before the native context is available', async () => {
    const { eventsPath, connected, failed } = await setup();
    // The pinned context loader has no team/run fields when reading its private file fails.
    await appendFile(
      eventsPath,
      JSON.stringify({
        version: 1,
        type: 'failed',
        timestamp: new Date().toISOString(),
        pid: processIdentity.pid,
        detail: 'TEST context load failed',
      }) + '\n'
    );
    await expect.poll(() => failed.mock.calls.length).toBe(1);
    expect(failed.mock.calls[0][0].message).toBe('TEST context load failed');
    expect(connected).not.toHaveBeenCalled();
  });

  it('retains partial JSONL across writes and never treats a truncated file as the same attempt', async () => {
    const { eventsPath, connected, failed } = await setup();
    const line = proof();
    await appendFile(eventsPath, line.slice(0, 30));
    await appendFile(eventsPath, line.slice(30));
    await expect.poll(() => connected.mock.calls.length).toBe(1);
    await writeFile(eventsPath, '');
    await expect.poll(() => failed.mock.calls.length).toBe(1);
    expect(failed.mock.calls[0][0].message).toContain('replaced or truncated');
    await appendFile(eventsPath, proof());
    expect(connected).toHaveBeenCalledOnce();
  });

  it('keeps observation scoped to one subscriber and detaches before owned files are removed', async () => {
    const { eventsPath, connected, source } = await setup();
    expect(() =>
      source.subscribe(processIdentity, { connected: vi.fn(), failed: vi.fn() })
    ).toThrow('subscriber');
    subscriptions.pop()?.();
    await appendFile(eventsPath, proof());
    expect(connected).not.toHaveBeenCalled();
  });
});
