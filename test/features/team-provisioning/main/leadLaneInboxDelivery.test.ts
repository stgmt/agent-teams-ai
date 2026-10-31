// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LeadLaneInboxDelivery } from '../../../../src/features/team-provisioning/main/adapters/output/LeadLaneInboxDelivery';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};

function snapshot(lead: Record<string, unknown>): TeamLifecycleSnapshot {
  return {
    identity: run,
    desired: 'running',
    members: {
      'team-lead': { memberName: 'team-lead', role: 'lead', generation: 2, ...lead },
    },
  } as unknown as TeamLifecycleSnapshot;
}

function setup(current = snapshot({ lane: { laneId: 'primary', sessionId: 'TEST-session' } })) {
  const sendMessage = vi.fn(async () => ({ messageId: 'TEST-message' }));
  const relay = vi.fn(async () => 1);
  const delivery = new LeadLaneInboxDelivery({
    snapshot: () => current,
    inbox: { sendMessage } as never,
    relay,
  });
  return { delivery, sendMessage, relay };
}

describe('lane lead system delivery', () => {
  it('writes a lead inbox row and relays it for a lane lead', async () => {
    const { delivery, sendMessage, relay } = setup();
    await expect(delivery.tryDeliver(run, 'TEST message')).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('TEST-team', {
      member: 'team-lead',
      to: 'team-lead',
      from: 'user',
      text: 'TEST message',
      source: 'user_sent',
    });
    expect(relay).toHaveBeenCalledWith('TEST-team', 'team-lead');
  });

  it('defers to the stdin path for a process lead', async () => {
    const { delivery, sendMessage } = setup(
      snapshot({ process: { pid: 42, birthId: 'TEST-birth' } })
    );
    await expect(delivery.tryDeliver(run, 'TEST message')).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects stale runs, empty text and attachments', async () => {
    const { delivery, sendMessage } = setup();
    await expect(delivery.tryDeliver({ ...run, runId: 'OTHER-run' }, 'TEST')).rejects.toThrow(
      'no longer current'
    );
    await expect(delivery.tryDeliver(run, '   ')).rejects.toThrow('must not be empty');
    await expect(
      delivery.tryDeliver(run, 'TEST', [{ data: 'TEST', mimeType: 'text/plain' } as never])
    ).rejects.toThrow('do not accept attachments');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
