import type { TeamRunRegistryRead } from '../../../contracts';
import type { MemberLaunchSettingsPort } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeTeamLifecycle } from '../../composition/createNativeTeamLifecycle';
import type {
  TeamMessageAttachmentPayload,
  TeamMessageSendOptions,
  TeamMessagingApi,
  TeamOpenCodeMemberInboxRelayOptions,
  TeamOpenCodeMemberInboxRelayResult,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { InboxMessage, OpenCodeRuntimeDeliveryStatus, TeamProviderId } from '@shared/types';

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find'>;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  sendLeadMessage: NativeTeamLifecycle['sendLeadMessage'];
  relayLeadInboxMessages(teamName: string): Promise<number>;
}

/**
 * System-path messaging over the native lifecycle. Human messages must use the
 * persisted human request ledger instead; live lead message caches stay empty.
 */
export class NativeTeamMessagingApi implements TeamMessagingApi {
  constructor(private readonly deps: Dependencies) {}

  async sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: TeamMessageAttachmentPayload[],
    _options?: TeamMessageSendOptions
  ): Promise<void> {
    const snapshot = this.requireRun(teamName);
    if (typeof message !== 'string' || !message.trim() || message.length > 64_000)
      throw new TypeError('A non-empty message of at most 64000 characters is required');
    if (attachments?.length)
      throw new Error('Native system messaging does not accept attachments yet');
    await this.deps.sendLeadMessage(snapshot.identity, message);
  }

  async resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) return undefined;
    const launch = await this.deps.settings.findConfiguredMember(snapshot.identity, memberName);
    return launch?.providerId as TeamProviderId | undefined;
  }

  getCurrentLeadSessionId(teamName: string): string | null {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) return null;
    const lead = Object.values(snapshot.members).find((member) => member.role === 'lead');
    return lead?.lane?.sessionId ?? null;
  }

  getLiveLeadProcessMessages(_teamName: string): InboxMessage[] {
    return [];
  }

  pushLiveLeadProcessMessage(_teamName: string, _message: InboxMessage): void {
    throw new Error('Live lead process messages are not migrated');
  }

  async relayOpenCodeMemberInboxMessages(
    _teamName: string,
    _memberName: string,
    _options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<TeamOpenCodeMemberInboxRelayResult> {
    throw new Error('OpenCode member inbox relay is not migrated');
  }

  async getOpenCodeRuntimeDeliveryStatus(
    _teamName: string,
    _messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    throw new Error('OpenCode runtime delivery status is not migrated');
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    this.requireRun(teamName);
    return this.deps.relayLeadInboxMessages(teamName);
  }

  private requireRun(teamName: string) {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    return snapshot;
  }
}
