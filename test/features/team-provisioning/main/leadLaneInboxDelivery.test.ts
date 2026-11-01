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

function setup(
  current = snapshot({ lane: { laneId: 'primary', sessionId: 'TEST-session' } }),
  delivery: { relayOpenCodeMemberInboxMessages: ReturnType<typeof vi.fn> } | null = {
    relayOpenCodeMemberInboxMessages: vi.fn(async () => ({ relayed: 1 })),
  }
) {
  const sendMessage = vi.fn(async () => ({ messageId: 'TEST-message' }));
  const instance = new LeadLaneInboxDelivery({
    snapshot: () => current,
    inbox: { sendMessage } as never,
    ...(delivery ? { deliver: delivery as never } : {}),
  });
  return { delivery: instance, sendMessage, ledger: delivery };
}

describe('lane lead system delivery', () => {
  it('writes a lead inbox row and proves delivery through the OpenCode ledger', async () => {
    const { delivery, sendMessage, ledger } = setup();
    await expect(delivery.tryDeliver(run, 'TEST message')).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('TEST-team', {
      member: 'team-lead',
      to: 'team-lead',
      from: 'user',
      text: 'TEST message',
      source: 'user_sent',
    });
    expect(ledger?.relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith(
      'TEST-team',
      'team-lead',
      { onlyMessageId: 'TEST-message', source: 'ui-send' }
    );
  });

  it('accepts a ledger delivery receipt without a relayed count', async () => {
    const { delivery } = setup(undefined, {
      relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
        relayed: 0,
        delivered: 0,
        attempted: 1,
        failed: 0,
        lastDelivery: { delivered: true },
      })),
    });
    await expect(delivery.tryDeliver(run, 'TEST message')).resolves.toBe(true);
  });

  it('fails loudly when the ledger reports no delivery proof', async () => {
    const { delivery } = setup(undefined, {
      relayOpenCodeMemberInboxMessages: vi.fn(async () => ({
        relayed: 0,
        delivered: 0,
        attempted: 1,
        failed: 1,
        diagnostics: ['session not found'],
      })),
    });
    await expect(delivery.tryDeliver(run, 'TEST message')).rejects.toThrow(
      'Lane lead message TEST-message for TEST-team was not delivered: session not found'
    );
  });

  it('never reports success when the OpenCode ledger is not configured', async () => {
    const { delivery, sendMessage } = setup(undefined, null);
    await expect(delivery.tryDeliver(run, 'TEST message')).rejects.toThrow(
      'the OpenCode delivery ledger is not configured'
    );
    // The durable row still exists, so the message is visible instead of lost.
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('defers to the stdin path for a process lead', async () => {
    const { delivery, sendMessage, ledger } = setup(
      snapshot({ process: { pid: 42, birthId: 'TEST-birth' } })
    );
    await expect(delivery.tryDeliver(run, 'TEST message')).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ledger?.relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
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
