import type { TeamLifecycleSnapshot, TeamRunIdentity } from '../../../contracts';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { AttachmentPayload } from '@shared/types';

interface Dependencies {
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  inbox: Pick<TeamInboxWriter, 'sendMessage'>;
  relay(teamName: string, memberName: string): Promise<number>;
}

/**
 * Lane leads have no stdin stream, so a system message becomes a normal lead
 * inbox row and the member relay delivers it. Process leads stay on stdin.
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
    await this.ports.inbox.sendMessage(identity.teamName, {
      member: lead.memberName,
      to: lead.memberName,
      from: 'user',
      text,
      source: 'user_sent',
    });
    await this.ports.relay(identity.teamName, lead.memberName);
    return true;
  }
}
