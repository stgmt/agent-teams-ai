import { describe, expect, it, vi } from 'vitest';

import { TEAM_LIFECYCLE_CHANNELS } from '../../../../src/features/team-provisioning/contracts';
import { createTeamLifecycleBridge } from '../../../../src/features/team-provisioning/preload/createTeamLifecycleBridge';

import type { InvokeIpcWithResult } from '../../../../src/features/team-provisioning/preload/createTeamMemberSettingsBridge';

const request = {
  expectedContext: {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: 'TEST-root',
    connectionGeneration: 1,
  },
  teamName: 'test-team',
};

describe('lifecycle contextBridge values', () => {
  it('transports only the unchanged query or opaque id through narrow channels', async () => {
    const invoke = vi.fn(async () => 'TEST-subscription');
    const bridge = createTeamLifecycleBridge(invoke as InvokeIpcWithResult);
    await bridge.getLifecycleSnapshot(request);
    const id = await bridge.openLifecycleSubscription(request);
    await bridge.readLifecycleSubscription(id);
    await bridge.closeLifecycleSubscription(id);
    expect(invoke.mock.calls).toEqual([
      [TEAM_LIFECYCLE_CHANNELS.snapshot, request],
      [TEAM_LIFECYCLE_CHANNELS.subscribe, request],
      [TEAM_LIFECYCLE_CHANNELS.next, 'TEST-subscription'],
      [TEAM_LIFECYCLE_CHANNELS.close, 'TEST-subscription'],
    ]);
  });
});
