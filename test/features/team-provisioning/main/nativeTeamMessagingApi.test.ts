// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTeamMessagingApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamMessagingApi';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

const snapshot = {
  identity: run,
  members: {
    'team-lead': {
      memberName: 'team-lead',
      role: 'lead',
      lane: { laneId: 'primary', sessionId: 'TEST-session' },
    },
  },
} as unknown as TeamLifecycleSnapshot;

function setup() {
  const sendLeadMessage = vi.fn(async () => undefined);
  const findConfiguredMember = vi.fn(async () => ({
    providerId: 'opencode',
  }));
  const api = new NativeTeamMessagingApi({
    runs: { find: (teamName) => (teamName === run.teamName ? snapshot : null) },
    settings: { findConfiguredMember } as never,
    sendLeadMessage,
  });
  return { api, sendLeadMessage, findConfiguredMember };
}

describe('native team messaging', () => {
  it('sends a system message to the exact lead run', async () => {
    const { api, sendLeadMessage } = setup();
    await api.sendMessageToTeam('test-team', 'TEST message');
    expect(sendLeadMessage).toHaveBeenCalledWith(snapshot.identity, 'TEST message');
    await expect(
      api.sendMessageToTeam('test-team', 'TEST message', [
        { data: 'TEST', mimeType: 'text/plain' as never },
      ])
    ).rejects.toThrow('does not accept attachments');
  });

  it('rejects an unknown team', async () => {
    const { api } = setup();
    await expect(api.sendMessageToTeam('absent', 'TEST message')).rejects.toThrow('Unknown team');
  });

  it('resolves the recipient provider and lane lead session', async () => {
    const { api, findConfiguredMember } = setup();
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'builder')).resolves.toBe(
      'opencode'
    );
    expect(findConfiguredMember).toHaveBeenCalledWith(run, 'builder');
    expect(api.getCurrentLeadSessionId('test-team')).toBe('TEST-session');
    expect(api.getCurrentLeadSessionId('absent')).toBeNull();
  });

  it('keeps unmigrated live lead message APIs explicit', () => {
    const { api } = setup();
    expect(api.getLiveLeadProcessMessages()).toEqual([]);
    expect(() => api.pushLiveLeadProcessMessage()).toThrow('not migrated');
  });
});
