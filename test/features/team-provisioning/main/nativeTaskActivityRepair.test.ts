// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTaskActivityRepair } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTaskActivityRepair';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

function setup(live: boolean) {
  const snapshot = { identity: run } as TeamLifecycleSnapshot;
  const runs = {
    aliveRunId: vi.fn(() => (live ? run.runId : null)),
    findByRunId: vi.fn((runId: string) => (runId === run.runId ? snapshot : null)),
    isLive: vi.fn(() => live),
  };
  const repairedTeams = { has: vi.fn(() => false), add: vi.fn() };
  const pendingSnapshots = {
    has: vi.fn(() => false),
    get: vi.fn(() => undefined),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const repairOnce = vi.fn(() => true);
  const repair = new NativeTaskActivityRepair({
    runs,
    tracking: { repairedTeams, pendingSnapshots },
    readRepairLaunchSnapshot: async () => null,
    repairOnce,
  });
  return { repair, repairedTeams, repairOnce };
}

describe('native task activity repair', () => {
  it('skips repair while the run is live in the native registry', async () => {
    const { repair, repairOnce } = setup(true);
    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('test-team');
    expect(repairOnce).not.toHaveBeenCalled();
  });

  it('repairs once when no live native run owns the team', async () => {
    const { repair, repairOnce } = setup(false);
    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('test-team');
    expect(repairOnce).toHaveBeenCalledWith('test-team', null);
  });

  it('does nothing for a team already repaired in this pass', async () => {
    const { repair, repairedTeams, repairOnce } = setup(false);
    repairedTeams.has.mockReturnValueOnce(true);
    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('test-team');
    expect(repairOnce).not.toHaveBeenCalled();
  });
});
