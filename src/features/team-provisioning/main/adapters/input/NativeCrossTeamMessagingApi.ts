import {
  LiveInboxRelayKind,
  type LiveInboxRelayResult,
  type NativeLeadInboxRelayOptions,
  relayInboxFileToLiveRecipientWithPorts,
} from '@main/services/team/provisioning/TeamProvisioningLiveInboxRelayRouting';
import { createOpenCodeMemberInboxRelayResult } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberInboxRelayResults';

import type { TeamLifecycleSnapshot, TeamRunRegistryRead } from '../../../contracts';
import type { MemberLaunchSettingsPort } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeCrossTeamReplyLedger } from '../output/NativeCrossTeamReplyLedger';
import type { NativeOpenCodeMemberDeliveryPort } from './NativeTeamMessagingApi';
import type { TeamCrossTeamMessagingApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { InboxMessage, TeamConfig, TeamMember } from '@shared/types';

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  replyLedger: Pick<
    NativeCrossTeamReplyLedger,
    'register' | 'clear' | 'resolveSingle' | 'wasDeliveredToLead'
  >;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  inbox: { getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> };
  relayLeadInboxMessages(teamName: string, options?: NativeLeadInboxRelayOptions): Promise<number>;
  /** Production OpenCode prompt ledger; absent keeps OpenCode delivery fail-closed. */
  openCodeMemberDelivery?: NativeOpenCodeMemberDeliveryPort;
  now?(): number;
}

/**
 * Cross-team messaging over the native lifecycle. Reply expectations live in
 * the lifecycle ledger shared with the lead relay, and runtime delivery is
 * proven by the same native relay / durable inbox / OpenCode ledger evidence
 * the legacy route used instead of a second copy of the routing decision.
 *
 * Lead-recovery probes stay fail-closed: recovery nudges are created by the
 * legacy recovery path, so the native route never claims recovery proof it
 * cannot produce. That only omits `lastDelivery`; it cannot report a delivery
 * that did not happen.
 */
export class NativeCrossTeamMessagingApi implements TeamCrossTeamMessagingApi {
  constructor(private readonly deps: Dependencies) {}

  isTeamAlive(teamName: string): boolean {
    const snapshot = this.deps.runs.find(teamName);
    return Boolean(snapshot && this.deps.runs.isLive(snapshot.identity));
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    if (!this.isTeamAlive(teamName)) return null;
    return this.deps.replyLedger.resolveSingle(teamName, toTeam, this.now());
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    this.deps.replyLedger.register(teamName, otherTeam, conversationId, this.now());
  }

  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    this.deps.replyLedger.clear(teamName, otherTeam, conversationId);
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    if (!this.isTeamAlive(teamName)) return 0;
    return this.deps.relayLeadInboxMessages(teamName);
  }

  async relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options = {}
  ): Promise<LiveInboxRelayResult> {
    let openCodeMembers: ReadonlySet<string>;
    try {
      openCodeMembers = await this.resolveOpenCodeRecipients(teamName, inboxName);
    } catch (error) {
      // Provider identity is a routing input: an unreadable provider must not
      // fall through to a Claude-lead relay for an OpenCode member.
      return {
        kind: LiveInboxRelayKind.Ignored,
        relayed: 0,
        diagnostics: [`runtime identity resolution failed: ${describeError(error)}`],
      };
    }

    return relayInboxFileToLiveRecipientWithPorts(
      { teamName, inboxName, options },
      {
        readConfigSnapshot: async (targetTeam) => this.readConfigSnapshot(targetTeam),
        // The native registry is the only member directory; there is no second
        // metadata store to reconcile against.
        readMetaMembers: async () => [],
        readInboxMessages: (targetTeam, memberName) =>
          this.deps.inbox.getMessagesFor(targetTeam, memberName),
        isOpenCodeRuntimeRecipientFromSources: ({ memberName }) =>
          openCodeMembers.has(normalizeMemberKey(memberName)),
        relayOpenCodeMemberInboxMessages: (targetTeam, memberName, relayOptions) => {
          const delivery = this.deps.openCodeMemberDelivery;
          if (!delivery)
            return Promise.resolve(
              createOpenCodeMemberInboxRelayResult({
                diagnostics: ['OpenCode member delivery ledger is not configured'],
              })
            );
          return delivery.relayOpenCodeMemberInboxMessages(targetTeam, memberName, relayOptions);
        },
        relayLeadInboxMessages: (targetTeam, leadOptions) =>
          this.deps.relayLeadInboxMessages(targetTeam, leadOptions),
        wasRecentlyDeliveredToLead: (targetTeam, messageId) =>
          this.deps.replyLedger.wasDeliveredToLead(targetTeam, messageId, this.now()),
        hasSuccessfulLeadRecoveryMessage: () => false,
        isLeadRecoveryMessage: () => false,
        isTeamAlive: (targetTeam) => this.isTeamAlive(targetTeam),
      }
    );
  }

  /**
   * Resolves the provider of the one member the routing helper can ask about.
   * The helper only queries the canonical recipient, so resolving the whole
   * roster would turn an unrelated member's unreadable settings (for example a
   * configuration revision bump mid-run) into a failed relay for everyone.
   *
   * A requested name that matches no member canonicalizes to the lead, so the
   * lead is resolved only in that case.
   */
  private async resolveOpenCodeRecipients(
    teamName: string,
    inboxName: string
  ): Promise<ReadonlySet<string>> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) return new Set();
    const configured = Object.values(snapshot.members).filter(
      (member) => member.membership === 'configured'
    );
    const requested = normalizeMemberKey(inboxName);
    const direct = configured.find(
      (member) => normalizeMemberKey(member.memberName) === requested
    );
    const target = direct ?? configured.find((member) => member.role === 'lead');
    if (!target) return new Set();
    const launch = await this.deps.settings.findConfiguredMember(
      snapshot.identity,
      target.memberName
    );
    return launch?.providerId === 'opencode'
      ? new Set([normalizeMemberKey(target.memberName)])
      : new Set();
  }

  private readConfigSnapshot(teamName: string): TeamConfig | null {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) return null;
    return {
      name: snapshot.identity.teamName,
      members: Object.values(snapshot.members).map(toIdentityMember),
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/**
 * Projects a native member into the identity shape the shared resolver reads.
 * Lead detection there is by agent type, so the lifecycle role is translated
 * once instead of teaching the shared resolver a second vocabulary.
 */
function toIdentityMember(member: Readonly<TeamLifecycleSnapshot['members'][string]>): TeamMember {
  return {
    name: member.memberName,
    agentType: member.role === 'lead' ? 'team-lead' : 'member',
    ...(member.membership === 'removed' ? { removedAt: 0 } : {}),
  };
}

function normalizeMemberKey(value: string): string {
  return value.trim().toLowerCase();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
