// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTeamDiagnostics } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamDiagnostics';

import type {
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';

const run: TeamRunIdentity = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

function member(memberName: string, role: 'lead' | 'member', phase: 'ready' | 'failed' = 'ready') {
  return {
    memberName,
    role,
    membership: 'configured' as const,
    desired: 'running' as const,
    phase,
    resources: 'held' as const,
    generation: 1,
    operationId: `TEST-op-${memberName}`,
    process: { pid: role === 'lead' ? 100 : 101, birthId: `TEST-birth-${memberName}` },
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
  };
}

function snapshot(overrides: Partial<TeamLifecycleSnapshot> = {}): TeamLifecycleSnapshot {
  return {
    identity: run,
    desired: 'running',
    resources: 'held',
    state: 'ready',
    error: null,
    version: 1,
    startedAt: '2026-10-31T00:00:00.000Z',
    members: {
      'team-lead': member('team-lead', 'lead'),
      builder: member('builder', 'member'),
    },
    ...overrides,
  };
}

function setup(
  options: {
    lines?: string[];
    live?: boolean;
    current?: TeamLifecycleSnapshot;
  } = {}
) {
  const runtimeSnapshot = vi.fn(async () => ({
    teamName: run.teamName,
    updatedAt: '2026-10-31T00:00:00.000Z',
    runId: run.runId,
    members: {},
  }));
  const api = new NativeTeamDiagnostics({
    statuses: { runtimeSnapshot },
    runs: {
      find: (teamName) => (teamName === run.teamName ? (options.current ?? snapshot()) : null),
      isLive: () => options.live ?? true,
    },
    logs: {
      read: () => ({
        lines: options.lines ?? [],
        total: (options.lines ?? []).length,
        hasMore: false,
      }),
    },
  });
  return { api, runtimeSnapshot };
}

describe('native lead activity diagnostics', () => {
  it('reports active while the newest stream event is a lead turn event', () => {
    const { api } = setup({ lines: [JSON.stringify({ type: 'assistant' })] });
    expect(api.getLeadActivityState(run.teamName)).toEqual({
      state: 'active',
      runId: run.runId,
    });
  });

  it('reports idle after a terminal result or system event', () => {
    const { api } = setup({
      lines: [JSON.stringify({ type: 'result' }), JSON.stringify({ type: 'assistant' })],
    });
    expect(api.getLeadActivityState(run.teamName)).toEqual({
      state: 'idle',
      runId: run.runId,
    });
  });

  it('reports offline for a stopped run, missing lead or failed lead', () => {
    expect(setup({ live: false }).api.getLeadActivityState(run.teamName)).toEqual({
      state: 'offline',
      runId: null,
    });
    const noLead = snapshot({ members: { builder: member('builder', 'member') } });
    expect(setup({ current: noLead }).api.getLeadActivityState(run.teamName)).toEqual({
      state: 'offline',
      runId: null,
    });
    const failedLead = snapshot({
      members: { 'team-lead': member('team-lead', 'lead', 'failed') },
    });
    expect(setup({ current: failedLead }).api.getLeadActivityState(run.teamName)).toEqual({
      state: 'offline',
      runId: null,
    });
  });

  it('keeps context usage fail-closed', () => {
    const { api } = setup();
    expect(() => api.getLeadContextUsage(run.teamName)).toThrow('not migrated');
  });
});
