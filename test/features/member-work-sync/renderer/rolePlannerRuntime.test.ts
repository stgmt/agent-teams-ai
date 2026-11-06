import {
  isPlannerSnapshotTrusted,
  plannerRuntimeState,
  projectRuntimeForRolePlan,
} from '@features/member-work-sync/renderer/rolePlannerRuntime';
import { describe, expect, it } from 'vitest';

import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '@shared/types';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const entry = (overrides: Partial<TeamAgentRuntimeEntry> = {}): TeamAgentRuntimeEntry => ({
  memberName: 'member',
  alive: false,
  restartable: true,
  updatedAt: new Date(NOW).toISOString(),
  ...overrides,
});
const snapshot = (overrides: Partial<TeamAgentRuntimeSnapshot> = {}): TeamAgentRuntimeSnapshot => ({
  teamName: 'team',
  runId: 'run-1',
  updatedAt: new Date(NOW).toISOString(),
  members: { member: entry({ alive: true, livenessKind: 'runtime_process' }) },
  ...overrides,
});

describe('role planner runtime evidence', () => {
  it('does not confuse ambiguous or permission-blocked runtime entries with stopped roles', () => {
    expect(plannerRuntimeState(entry({ livenessKind: 'permission_blocked' }))).toBe('unknown');
    expect(plannerRuntimeState(entry({ livenessKind: 'runtime_process_candidate' }))).toBe(
      'unknown'
    );
    expect(plannerRuntimeState(entry({ alive: true, livenessKind: 'registered_only' }))).toBe(
      'unknown'
    );
    expect(plannerRuntimeState(entry())).toBe('unknown');
    expect(plannerRuntimeState(entry({ livenessKind: 'not_found' }))).toBe('stopped');
    expect(plannerRuntimeState(entry({ livenessKind: 'stale_metadata' }))).toBe('stopped');
    expect(plannerRuntimeState(entry({ alive: true, livenessKind: 'runtime_process' }))).toBe(
      'running'
    );
  });

  it('recognizes the live lead-process projection while keeping weak or contradictory lead evidence unknown', () => {
    const lead = entry({
      memberName: 'team-lead',
      backendType: 'lead',
      alive: true,
      restartable: false,
      pid: 1234,
      pidSource: 'lead_process',
    });
    expect(plannerRuntimeState(lead)).toBe('running');
    expect(plannerRuntimeState({ ...lead, pid: undefined })).toBe('unknown');
    expect(plannerRuntimeState({ ...lead, pidSource: 'persisted_metadata' })).toBe('unknown');
    expect(plannerRuntimeState({ ...lead, livenessKind: 'permission_blocked' })).toBe('unknown');
    expect(plannerRuntimeState({ ...lead, backendType: 'process' })).toBe('unknown');
    expect(plannerRuntimeState({ ...lead, alive: false })).toBe('unknown');
  });

  it('rejects stale, mismatched, missing-run or changed snapshots', () => {
    const fresh = snapshot();
    expect(isPlannerSnapshotTrusted(fresh, fresh, 'team', NOW)).toBe(true);
    expect(isPlannerSnapshotTrusted(fresh, fresh, 'team', NOW + 60_001)).toBe(false);
    expect(isPlannerSnapshotTrusted(snapshot({ runId: null }), undefined, 'team', NOW)).toBe(false);
    expect(isPlannerSnapshotTrusted(fresh, fresh, 'other-team', NOW)).toBe(false);
    expect(isPlannerSnapshotTrusted(fresh, snapshot({ runId: 'run-2' }), 'team', NOW)).toBe(false);
    expect(isPlannerSnapshotTrusted(fresh, snapshot({ teamName: 'another' }), 'team', NOW)).toBe(
      false
    );
    expect(
      isPlannerSnapshotTrusted(fresh, snapshot({ members: { member: entry() } }), 'team', NOW)
    ).toBe(false);
    const lead = entry({
      memberName: 'lead',
      backendType: 'lead',
      alive: true,
      pid: 42,
      pidSource: 'lead_process',
    });
    const leadSnapshot = snapshot({ members: { lead } });
    const changedSource = snapshot({
      members: { lead: { ...lead, pidSource: 'persisted_metadata' } },
    });
    expect(isPlannerSnapshotTrusted(leadSnapshot, changedSource, 'team', NOW)).toBe(false);
  });

  it.each([
    ['providerId', 'codex'],
    ['providerBackendId', 'codex-native'],
    ['runtimeModel', 'new-model'],
    ['runtimeSessionId', 'new-session'],
    ['runtimePid', 4321],
    ['laneId', 'new-lane'],
    ['laneKind', 'secondary'],
  ] as const)('invalidates the snapshot when runtime identity %s changes', (field, value) => {
    const live = entry({ alive: true, livenessKind: 'runtime_process', pid: 1234 });
    const before = snapshot({ members: { member: live } });
    const after = snapshot({ members: { member: { ...live, [field]: value } } });
    expect(isPlannerSnapshotTrusted(before, after, 'team', NOW)).toBe(false);
  });

  it('invalidates the snapshot when team runtime settings change', () => {
    const before = snapshot();
    expect(
      isPlannerSnapshotTrusted(
        before,
        { ...before, providerBackendId: 'codex-native' },
        'team',
        NOW
      )
    ).toBe(false);
    expect(isPlannerSnapshotTrusted(before, { ...before, fastMode: 'on' }, 'team', NOW)).toBe(
      false
    );
  });

  it('counts alive entries conservatively and blocks uncertain or duplicated occupancy', () => {
    const projected = projectRuntimeForRolePlan(
      snapshot({
        members: {
          a: entry({
            memberName: 'CEO',
            backendType: 'lead',
            alive: true,
            livenessKind: 'runtime_process',
          }),
          b: entry({ memberName: 'Agent', alive: true, livenessKind: 'registered_only' }),
          c: entry({ memberName: 'agent', livenessKind: 'not_found' }),
        },
      }),
      true
    );
    expect(projected.runningRuntimeMembers).toEqual(['CEO', 'Agent']);
    expect(projected.leadRuntimeMembers).toEqual(['CEO']);
    expect(projected.stateFor('agent')).toBe('unknown');
    expect(projected.runtimeOccupancyUncertain).toBe(true);
  });
});
