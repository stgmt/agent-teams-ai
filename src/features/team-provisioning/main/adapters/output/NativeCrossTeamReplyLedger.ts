import {
  buildCrossTeamConversationKey,
  clearPendingCrossTeamReplyExpectation,
  getPendingCrossTeamReplyExpectationKeys,
  registerPendingCrossTeamReplyExpectation,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  wasRecentlyDeliveredToLead,
} from '@main/services/team/provisioning/TeamProvisioningCrossTeamRelayHelpers';

import type { NativeLeadInboxRelayCrossTeamState } from './NativeLeadInboxRelay';

export interface NativeCrossTeamReplyMetadata {
  conversationId: string;
  replyToConversationId: string;
}

/**
 * Cross-team correlation ledger for the native lifecycle. One instance is
 * shared by the lead inbox relay and cross-team sends so an expectation
 * registered by either side answers the other, exactly like the legacy maps.
 *
 * State is keyed by team name and cleared on run release, so a stale
 * expectation can never outlive the run that created it.
 */
export class NativeCrossTeamReplyLedger {
  private readonly pendingReplies = new Map<string, Map<string, number>>();
  private readonly recentDeliveries = new Map<string, Map<string, number>>();

  /** Shared maps for the lead relay; the relay must not own a second copy. */
  get state(): NativeLeadInboxRelayCrossTeamState {
    return {
      pendingReplies: this.pendingReplies,
      recentDeliveries: this.recentDeliveries,
    };
  }

  register(
    teamName: string,
    otherTeam: string,
    conversationId: string,
    now: number = Date.now()
  ): void {
    registerPendingCrossTeamReplyExpectation(
      this.pendingReplies,
      teamName,
      otherTeam,
      conversationId,
      now
    );
  }

  clear(teamName: string, otherTeam: string, conversationId: string): void {
    clearPendingCrossTeamReplyExpectation(
      this.pendingReplies,
      teamName,
      otherTeam,
      conversationId
    );
  }

  /**
   * Answers the one live expectation this team holds for `toTeam`. Two or more
   * conversations are ambiguous, so the caller must supply metadata itself.
   */
  resolveSingle(teamName: string, toTeam: string, now: number = Date.now()): NativeCrossTeamReplyMetadata | null {
    const normalizedToTeam = toTeam.trim();
    if (!normalizedToTeam) return null;
    const keys = [...getPendingCrossTeamReplyExpectationKeys(this.pendingReplies, teamName, now)];
    const matches = keys.filter(
      (key) => key.slice(0, key.indexOf('\0')).trim().toLowerCase() === normalizedToTeam.toLowerCase()
    );
    if (matches.length !== 1) return null;
    const conversationId = matches[0].slice(matches[0].indexOf('\0') + 1);
    if (!conversationId) return null;
    return { conversationId, replyToConversationId: conversationId };
  }

  rememberLeadDelivery(
    teamName: string,
    messageIds: readonly string[],
    now: number = Date.now(),
    ttlMs?: number
  ): void {
    rememberRecentCrossTeamLeadDeliveryMessageIds(
      this.recentDeliveries,
      teamName,
      messageIds,
      now,
      ttlMs
    );
  }

  wasDeliveredToLead(teamName: string, messageId: string, now: number = Date.now()): boolean {
    return wasRecentlyDeliveredToLead(this.recentDeliveries, teamName, messageId, now);
  }

  /** Mirrors the relay reset: every expectation and delivery proof for one team. */
  reset(teamName: string): void {
    const normalized = teamName.trim();
    if (!normalized) return;
    this.pendingReplies.delete(normalized);
    this.recentDeliveries.delete(normalized);
  }

  resetAll(): void {
    this.pendingReplies.clear();
    this.recentDeliveries.clear();
  }

  /** Message key shape used by the shared helpers; exported for tests and diagnostics. */
  static conversationKey(otherTeam: string, conversationId: string): string {
    return buildCrossTeamConversationKey(otherTeam, conversationId);
  }
}
