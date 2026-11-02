// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeTaskActivityRepair } from '../../../../src/features/team-provisioning/main/composition/createNativeTaskActivityRepair';

import type { TaskActivityRepairServicePort } from '@main/services/team/provisioning/TeamProvisioningTaskActivityRepair';

function sources(
  overrides: Partial<Parameters<typeof createNativeTaskActivityRepair>[0]> = {}
) {
  const intervals: TaskActivityRepairServicePort = {
    repairStaleIntervalsAfterCrash: vi.fn(() => ({ repaired: true }) as never),
  };
  return {
    intervals,
    readLaunchState: async () => null,
    readBootstrapLaunchSnapshot: async () => null,
    getTrackedRunId: () => null,
    hasRun: () => false,
    ...overrides,
  };
}

describe('native task activity repair', () => {
  it('repairs a team whose run is gone, once', async () => {
    const deps = sources();
    const repair = createNativeTaskActivityRepair(deps);

    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('TEST-team');
    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('TEST-team');

    expect(deps.intervals.repairStaleIntervalsAfterCrash).toHaveBeenCalledTimes(1);
  });

  it('leaves a live run alone', async () => {
    const deps = sources({ getTrackedRunId: () => 'run-1', hasRun: () => true });
    const repair = createNativeTaskActivityRepair(deps);

    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('TEST-team');

    expect(deps.intervals.repairStaleIntervalsAfterCrash).not.toHaveBeenCalled();
  });

  it('repairs each team independently', async () => {
    const deps = sources();
    const repair = createNativeTaskActivityRepair(deps);

    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('TEST-a');
    await repair.repairStaleTaskActivityIntervalsBeforeSnapshot('TEST-b');

    expect(deps.intervals.repairStaleIntervalsAfterCrash).toHaveBeenCalledTimes(2);
  });
});
