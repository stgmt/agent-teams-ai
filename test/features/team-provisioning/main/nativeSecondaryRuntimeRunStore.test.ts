// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNativeSecondaryRuntimeRunStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeSecondaryRuntimeRunStore';

const lane = (laneId: string) => ({
  teamName: 'TEST-team',
  runId: `run-${laneId}`,
  providerId: 'opencode' as const,
  laneId,
  memberName: `member-${laneId}`,
});

describe('secondary runtime run store', () => {
  it('records lanes per team and drops the team once its last lane is gone', () => {
    const store = createNativeSecondaryRuntimeRunStore();

    store.setSecondaryRuntimeRun(lane('a'));
    store.setSecondaryRuntimeRun(lane('b'));
    expect(store.hasSecondaryRuntimeRuns('TEST-team')).toBe(true);
    expect(store.getSecondaryRuntimeRuns('TEST-team').map((entry) => entry.laneId)).toEqual([
      'a',
      'b',
    ]);

    store.deleteSecondaryRuntimeRun('TEST-team', 'a');
    expect(store.hasSecondaryRuntimeRuns('TEST-team')).toBe(true);
    store.deleteSecondaryRuntimeRun('TEST-team', 'b');
    expect(store.hasSecondaryRuntimeRuns('TEST-team')).toBe(false);
    expect(store.listTrackedTeamNames()).toEqual([]);
  });

  it('keeps the primary run independent from the lanes', () => {
    const store = createNativeSecondaryRuntimeRunStore();

    store.setPrimaryRuntimeRun('TEST-team', { runId: 'run-lead', providerId: 'anthropic' });
    store.setSecondaryRuntimeRun(lane('a'));

    store.clearPrimaryRuntimeRun('TEST-team');
    expect(store.getPrimaryRuntimeRun('TEST-team')).toBeNull();
    expect(store.getSecondaryRuntimeRuns('TEST-team')).toHaveLength(1);

    store.clearSecondaryRuntimeRuns('TEST-team');
    expect(store.hasSecondaryRuntimeRuns('TEST-team')).toBe(false);
  });

  it('replaces a lane in place when the same lane reports a new run', () => {
    const store = createNativeSecondaryRuntimeRunStore();

    store.setSecondaryRuntimeRun(lane('a'));
    store.setSecondaryRuntimeRun({ ...lane('a'), runId: 'run-a-2' });

    const entries = store.getSecondaryRuntimeRuns('TEST-team');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe('run-a-2');
  });

  it('ignores a delete for a team it never tracked', () => {
    const store = createNativeSecondaryRuntimeRunStore();

    expect(() => store.deleteSecondaryRuntimeRun('TEST-unknown', 'a')).not.toThrow();
    expect(store.listTrackedTeamNames()).toEqual([]);
  });
});
