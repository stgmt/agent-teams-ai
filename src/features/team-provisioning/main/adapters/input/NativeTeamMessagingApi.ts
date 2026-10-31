import type { TeamRunRegistryRead } from '../../../contracts';
import type { MemberLaunchSettingsPort } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeTeamLifecycle } from '../../composition/createNativeTeamLifecycle';
import type {
  TeamMessageAttachmentPayload,
  TeamMessageSendOptions,
  TeamMessagingApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { InboxMessage, TeamProviderId } from '@shared/types';

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find'>;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  sendLeadMessage: NativeTeamLifecycle['sendLeadMessage'];
}

/**
 * System-path messaging over the native lifecycle. Human messages must use the
 * persisted human request ledger instead; live lead message caches and relay
 * are not migrated.
 */
export class NativeTeamMessagingApi implements Pick<
  TeamMessagingApi,
  | 'sendMessageToTeam'
  | 'resolveRuntimeRecipientProviderId'
  | 'getCurrentLeadSessionId'
  | 'getLiveLeadProcessMessages'
  | 'pushLiveLeadProcessMessage'
> {
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

  getLiveLeadProcessMessages(): InboxMessage[] {
    return [];
  }

  pushLiveLeadProcessMessage(): void {
    throw new Error('Live lead process messages are not migrated');
  }

  private requireRun(teamName: string) {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    return snapshot;
  }
}
