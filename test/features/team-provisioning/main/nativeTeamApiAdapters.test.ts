// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTeamMemberLifecycleApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamMemberLifecycleApi';
import { NativeTeamToolApprovalApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamToolApprovalApi';
import { NativeTeamClaudeLogs } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamClaudeLogs';
import { NativeTeamDiagnostics } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamDiagnostics';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };

const snapshot = {
  identity: run,
  members: {
    builder: { memberName: 'builder', role: 'member', generation: 3 },
  },
} as unknown as TeamLifecycleSnapshot;

function memberApi(snap: TeamLifecycleSnapshot = snapshot) {
  const restartMember = vi.fn(async () => ({ kind: 'already-running' as const }));
  const skipMember = vi.fn(async () => undefined);
  const retryFailedLanes = vi.fn(async () => ({
    attempted: [],
    confirmed: [],
    pending: [],
    failed: [],
    skipped: [],
  }));
  const memberSpawnStatuses = vi.fn(async () => ({
    statuses: {},
    runId: run.runId,
    expectedMembers: [],
    source: 'live' as const,
  }));
  const api = new NativeTeamMemberLifecycleApi({
    owner,
    runs: { find: (teamName) => (teamName === run.teamName ? snap : null) },
    commands: { restartMember, skipMember, retryFailedLanes },
    statuses: { memberSpawnStatuses },
  });
  return { api, restartMember, skipMember, retryFailedLanes, memberSpawnStatuses };
}

describe('native team API adapters', () => {
  it('serves logs from the native store', async () => {
    const logs = {
      read: vi.fn(() => ({ lines: ['TEST line'], total: 1, hasMore: false })),
    };
    const api = new NativeTeamClaudeLogs(logs);
    await expect(api.getClaudeLogs('test-team', { limit: 1 })).resolves.toMatchObject({
      lines: ['TEST line'],
      total: 1,
    });
    expect(logs.read).toHaveBeenCalledWith('test-team', { limit: 1 });
  });

  it('serves the runtime snapshot and fails closed on legacy lead diagnostics', async () => {
    const runtimeSnapshot = vi.fn(async () => ({
      teamName: 'test-team',
      updatedAt: 'now',
      runId: run.runId,
      members: {},
    }));
    const api = new NativeTeamDiagnostics({ runtimeSnapshot });
    await expect(api.getTeamAgentRuntimeSnapshot('test-team')).resolves.toMatchObject({
      runId: run.runId,
    });
    expect(() => api.getLeadActivityState('test-team')).toThrow('not migrated');
    expect(() => api.getLeadContextUsage('test-team')).toThrow('not migrated');
  });

  it('drives restart and skip from the exact observed member generation', async () => {
    const { api, restartMember, skipMember } = memberApi();
    await api.restartMember('test-team', 'builder');
    expect(restartMember).toHaveBeenCalledWith({
      ...owner,
      teamName: 'test-team',
      runId: run.runId,
      memberName: 'builder',
      generation: 3,
    });
    await api.skipMemberForLaunch('test-team', 'builder');
    expect(skipMember).toHaveBeenCalledWith(expect.objectContaining({ generation: 3 }));
  });

  it('rejects unknown teams and members before calling a command', async () => {
    const { api, restartMember } = memberApi();
    await expect(api.restartMember('absent', 'builder')).rejects.toThrow('Unknown team');
    await expect(api.restartMember('test-team', 'ghost')).rejects.toThrow('Unknown member');
    expect(restartMember).not.toHaveBeenCalled();
  });

  it('fails closed for live roster operations and retries failed secondary lanes', async () => {
    const { api, retryFailedLanes } = memberApi();
    await expect(api.attachLiveRosterMember('test-team', 'builder')).rejects.toThrow(
      'not migrated'
    );
    await expect(api.detachLiveRosterMember('test-team', 'builder')).rejects.toThrow(
      'not migrated'
    );
    await expect(api.retryFailedOpenCodeSecondaryLanes('test-team')).resolves.toMatchObject({
      attempted: [],
    });
    expect(retryFailedLanes).toHaveBeenCalledWith(snapshot.identity);
    await expect(api.restartMember('test-team', 'builder', true)).rejects.toThrow('not migrated');
    const mutation = vi.fn(async () => undefined);
    await api.runLiveRosterMutation('test-team', mutation);
    expect(mutation).toHaveBeenCalledOnce();
  });

  it('projects live member spawn statuses', async () => {
    const { api, memberSpawnStatuses } = memberApi();
    await expect(api.getMemberSpawnStatuses('test-team')).resolves.toMatchObject({
      runId: run.runId,
      source: 'live',
    });
    expect(memberSpawnStatuses).toHaveBeenCalledWith({ teamName: 'test-team' });
  });

  it('answers lane tool approvals by the exact run and rejects unknown runs', async () => {
    const answerLanePermission = vi.fn(async () => undefined);
    const api = new NativeTeamToolApprovalApi({
      runs: { find: (teamName) => (teamName === run.teamName ? snapshot : null) },
      commands: { answerLanePermission },
    });
    await api.respondToToolApproval('test-team', run.runId, 'TEST-request', true, 'TEST allow');
    expect(answerLanePermission).toHaveBeenCalledWith({
      run: snapshot.identity,
      requestId: 'TEST-request',
      allow: true,
      message: 'TEST allow',
    });
    await expect(
      api.respondToToolApproval('test-team', 'TEST-other-run', 'TEST-request', false)
    ).rejects.toThrow('Unknown runId');
    expect(() => api.updateToolApprovalSettings('test-team', {} as never)).toThrow('not migrated');
  });

  it('falls back to Claude approvals when the lane has no such request', async () => {
    const respond = vi.fn(async () => true);
    const api = new NativeTeamToolApprovalApi({
      runs: { find: (teamName) => (teamName === run.teamName ? snapshot : null) },
      commands: {
        answerLanePermission: vi.fn(async () => {
          throw new Error('Unknown permission request');
        }),
      },
      claudeApprovals: { respond },
    });
    await api.respondToToolApproval('test-team', run.runId, 'TEST-request', false, 'TEST deny');
    expect(respond).toHaveBeenCalledWith(run.runId, 'TEST-request', false, 'TEST deny');
  });

  it('delegates tool approval settings when a store is supplied', () => {
    const update = vi.fn();
    const api = new NativeTeamToolApprovalApi({
      runs: { find: () => null },
      commands: { answerLanePermission: vi.fn() },
      settings: { update },
    });
    const settings = { autoAllowAll: true } as never;
    api.updateToolApprovalSettings('test-team', settings);
    expect(update).toHaveBeenCalledWith('test-team', settings);
  });
});
