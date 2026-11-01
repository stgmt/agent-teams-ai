import type { TeamRunRegistryRead } from '../../../contracts';
import type { MemberLaunchSettingsPort } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeTeamLifecycle } from '../../composition/createNativeTeamLifecycle';
import type { NativeLeadLiveMessageStore } from '../output/NativeLeadLiveMessageStore';
import type { NativeLeadOutputStream } from '../output/NativeLeadOutputStream';
import type {
  TeamMessageAttachmentPayload,
  TeamMessageSendOptions,
  TeamMessagingApi,
  TeamOpenCodeMemberInboxRelayOptions,
  TeamOpenCodeMemberInboxRelayResult,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { InboxMessage, OpenCodeRuntimeDeliveryStatus, TeamProviderId } from '@shared/types';

/**
 * OpenCode member prompt delivery is a durable ledger with acceptance proof and
 * watchdogs. It owns no runs or processes, so it is injected instead of rebuilt
 * here; the composition supplies the production ledger.
 */
export type NativeOpenCodeMemberDeliveryPort = Pick<
  TeamMessagingApi,
  'relayOpenCodeMemberInboxMessages' | 'getOpenCodeRuntimeDeliveryStatus'
>;

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  liveLeadMessages: Pick<NativeLeadLiveMessageStore, 'read' | 'push'>;
  /** Process-lead output capture; a lane lead carries its session on the lane instead. */
  leadOutput?: Pick<NativeLeadOutputStream, 'detectedSessionId'>;
  sendLeadMessage: NativeTeamLifecycle['sendLeadMessage'];
  relayLeadInboxMessages(teamName: string): Promise<number>;
  openCodeMemberDelivery?: NativeOpenCodeMemberDeliveryPort;
}

/**
 * System-path messaging over the native lifecycle. Human messages use the
 * persisted human request ledger; live messages use lifecycle-owned run state.
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
    return (
      lead?.lane?.sessionId ?? this.deps.leadOutput?.detectedSessionId(snapshot.identity.runId) ?? null
    );
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    const snapshot = this.liveSnapshot(teamName);
    if (!snapshot) return [];
    return this.deps.liveLeadMessages.read(snapshot.identity, this.getCurrentLeadSessionId(teamName));
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    const snapshot = this.liveSnapshot(teamName);
    // The legacy cache accepted rows for a dead team and silently kept them.
    // This store is run-scoped, so a row without a live run has nowhere to go;
    // dropping it is the only honest option, and the caller must never fail:
    // it runs after the message was already delivered and persisted.
    if (!snapshot) return;
    this.deps.liveLeadMessages.push(
      snapshot.identity,
      message,
      this.getCurrentLeadSessionId(teamName)
    );
  }

  private liveSnapshot(teamName: string) {
    const snapshot = this.deps.runs.find(teamName);
    return snapshot && this.deps.runs.isLive(snapshot.identity) ? snapshot : null;
  }

  private requireRun(teamName: string) {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    return snapshot;
  }

  async relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: TeamOpenCodeMemberInboxRelayOptions
  ): Promise<TeamOpenCodeMemberInboxRelayResult> {
    this.requireRun(teamName);
    const delivery = this.deps.openCodeMemberDelivery;
    if (!delivery) throw new Error('OpenCode member delivery ledger is not configured');
    return delivery.relayOpenCodeMemberInboxMessages(teamName, memberName, options);
  }

  async getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    const delivery = this.deps.openCodeMemberDelivery;
    if (!delivery) throw new Error('OpenCode member delivery ledger is not configured');
    return delivery.getOpenCodeRuntimeDeliveryStatus(teamName, messageId);
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    this.requireRun(teamName);
    return this.deps.relayLeadInboxMessages(teamName);
  }

}
