import type { TeamLifecycleSnapshot, TeamRunIdentity } from '../../../contracts';
import type { TeamMessagingApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { AttachmentPayload } from '@shared/types';

/** OpenCode prompt ledger; the only channel a lane lead can be woken through. */
export type LaneLeadDeliveryPort = Pick<TeamMessagingApi, 'relayOpenCodeMemberInboxMessages'>;

interface Dependencies {
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  inbox: Pick<TeamInboxWriter, 'sendMessage'>;
  /** Absent keeps lane lead delivery fail-closed instead of silently dropped. */
  deliver?: LaneLeadDeliveryPort;
}

/**
 * Lane leads have no stdin stream. A system message is written as a normal lead
 * inbox row and delivered by prompting the lead's runtime session through the
 * OpenCode delivery ledger - the member relay cannot wake a lead (it only
 * forwards member rows to a process lead), so claiming delivery without the
 * ledger would report success for a message nobody reads.
 *
 * Process leads stay on stdin and are handled by the caller.
 */
export class LeadLaneInboxDelivery {
  constructor(private readonly ports: Dependencies) {}

  /** Returns false when the lead is a process lead and the caller must write stdin. */
  async tryDeliver(
    identity: TeamRunIdentity,
    text: string,
    attachments: readonly Readonly<AttachmentPayload>[] = []
  ): Promise<boolean> {
    const snapshot = this.ports.snapshot(identity.teamName);
    const current = snapshot.identity;
    if (
      current.appInstanceId !== identity.appInstanceId ||
      current.dataRootFingerprint !== identity.dataRootFingerprint ||
      current.connectionGeneration !== identity.connectionGeneration ||
      current.runId !== identity.runId
    )
      throw new Error('Team run is no longer current');
    const lead = Object.values(snapshot.members).find((member) => member.role === 'lead');
    if (!lead?.lane || lead.process) return false;
    if (!text.trim()) throw new Error('Lead message must not be empty');
    if (attachments.length) throw new Error('Lane lead messages do not accept attachments yet');

    const written = await this.ports.inbox.sendMessage(identity.teamName, {
      member: lead.memberName,
      to: lead.memberName,
      from: 'user',
      text,
      source: 'user_sent',
    });
    const messageId = written.messageId?.trim();
    if (!messageId) throw new Error('Lane lead inbox write returned no message id');

    const delivery = this.ports.deliver;
    if (!delivery)
      throw new Error(
        `Lane lead message for ${identity.teamName} was stored but not delivered: ` +
          'the OpenCode delivery ledger is not configured'
      );
    const relay = await delivery.relayOpenCodeMemberInboxMessages(
      identity.teamName,
      lead.memberName,
      { onlyMessageId: messageId, source: 'ui-send' }
    );
    if (relay.relayed > 0 || relay.lastDelivery?.delivered === true) return true;
    throw new Error(
      `Lane lead message ${messageId} for ${identity.teamName} was not delivered: ` +
        (relay.diagnostics?.join('; ') || relay.lastDelivery?.reason || 'no delivery proof')
    );
  }
}
