import { hasGroupChatEnvelopeMarker } from '@features/team-group-chats/contracts';
import {
  clearPendingCrossTeamReplyExpectation,
  createCrossTeamLeadSuppressionState,
  markCrossTeamReplyToOwnOutbound,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  wasRecentlyDeliveredCrossTeamLeadMessage,
} from '@main/services/team/provisioning/TeamProvisioningCrossTeamRelayHelpers';
import { markTeamInboxMessagesReadWithDefaults } from '@main/services/team/provisioning/TeamProvisioningInboxPersistence';
import {
  buildLeadInboxRelayPrompt,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  getLeadInboxRelayNoiseIds,
  hasStableInboxMessageId,
  planLeadInboxRelayReadOnlyMessages,
  type RelayInboxMessage,
  selectActionableLeadRelayUnread,
  selectLeadInboxRelayBatch,
  shouldDeferSameTeamMessage,
  trimRelayedMessageIdSet,
} from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE } from '@shared/constants/crossTeam';

import type {
  TeamLifecycleSnapshot,
  TeamRunIdentity,
  TeamRunRegistryRead,
} from '../../../contracts';
import type { InboxMessage } from '@shared/types';

const SAME_TEAM_RUN_START_SKEW_MS = 1_000;
const SAME_TEAM_NATIVE_DELIVERY_GRACE_MS = 15_000;
const RECENT_CROSS_TEAM_DELIVERY_TTL_MS = 10 * 60 * 1000;
const RELAY_FOLLOW_UP_DELAY_MS = 50;
const WORK_SYNC_RETRY_COOLDOWN_MS = 60_000;

export interface NativeLeadInboxRelayCrossTeamState {
  pendingReplies: Map<string, Map<string, number>>;
  recentDeliveries: Map<string, Map<string, number>>;
}

export interface NativeLeadInboxRelayDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  inbox: { getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> };
  send(run: Readonly<TeamRunIdentity>, text: string): Promise<void>;
  teamsRoot: string;
  /** Marks the given inbox rows read; defaults to the shared inbox persistence helper. */
  markRead?(teamName: string, leadName: string, messageIds: readonly string[]): Promise<void>;
  controlUrl(): Promise<string | null>;
  /** Shared cross-team ledger; phase 8 wires the same maps as the cross-team service. */
  crossTeamState?: NativeLeadInboxRelayCrossTeamState;
  /** True when the lead already has an accepted work-sync report for this agenda. */
  hasAcceptedLeadWorkSyncReport?(input: { teamName: string; leadName: string }): Promise<boolean>;
  logger?: { debug(message: string): void };
  now?(): number;
  setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(handle: ReturnType<typeof setTimeout>): void;
}

export interface NativeLeadInboxRelayOptions {
  onlyMessageId?: string;
}

/**
 * Native lead inbox relay: reads the configured lead inbox, batches actionable
 * rows into one stdin prompt and commits them read only after the write
 * succeeded while the run is still live. Delivery proof is the transport write
 * (the same contract as the native member relay), not assistant text capture:
 * lead replies are published through MCP messaging and lead reporting, so this
 * adapter never owns a second reply stream. Permission-request rows are relayed
 * as ordinary text; native lane/process approvals own the answer channels.
 */
export class NativeLeadInboxRelay {
  private readonly relayed = new Map<string, Set<string>>();
  private readonly pendingCrossTeamReplies: Map<string, Map<string, number>>;
  private readonly recentCrossTeamDeliveries: Map<string, Map<string, number>>;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly polling = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly workSyncRetryAfter = new Map<string, number>();

  constructor(private readonly deps: NativeLeadInboxRelayDependencies) {
    this.pendingCrossTeamReplies = deps.crossTeamState?.pendingReplies ?? new Map();
    this.recentCrossTeamDeliveries = deps.crossTeamState?.recentDeliveries ?? new Map();
  }

  /** Serializes relays per team so one batch cannot overtake another. */
  relay(teamName: string, options: NativeLeadInboxRelayOptions = {}): Promise<number> {
    const previous = this.inFlight.get(teamName);
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.run(teamName, options);
    })();
    this.inFlight.set(teamName, work);
    void work
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(teamName) === work) this.inFlight.delete(teamName);
      });
    return work;
  }

  schedule(teamName: string, delayMs = 0): void {
    this.cancel(teamName);
    const handle = (this.deps.setTimer ?? setTimeout)(() => {
      this.timers.delete(teamName);
      void this.relay(teamName).catch(() => undefined);
    }, delayMs);
    (handle as { unref?: () => void }).unref?.();
    this.timers.set(teamName, handle);
  }

  cancel(teamName: string): void {
    const handle = this.timers.get(teamName);
    if (!handle) return;
    (this.deps.clearTimer ?? clearTimeout)(handle);
    this.timers.delete(teamName);
  }

  /** Polls the lead inbox while the caller keeps the run live; safe to call twice. */
  startPolling(teamName: string, intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new Error('Lead relay polling interval must be a positive integer');
    this.stopPolling(teamName);
    const handle = setInterval(() => {
      void this.relay(teamName).catch(() => undefined);
    }, intervalMs);
    handle.unref?.();
    this.polling.set(teamName, handle);
  }

  stopPolling(teamName: string): void {
    const handle = this.polling.get(teamName);
    if (!handle) return;
    clearInterval(handle);
    this.polling.delete(teamName);
  }

  dispose(): void {
    for (const teamName of [...this.timers.keys()]) this.cancel(teamName);
    for (const teamName of [...this.polling.keys()]) this.stopPolling(teamName);
  }

  /** Clears per-run relay state after a release; in-flight work still exits through isStale. */
  reset(teamName: string): void {
    this.cancel(teamName);
    this.stopPolling(teamName);
    this.relayed.delete(teamName);
    this.pendingCrossTeamReplies.delete(teamName);
    this.recentCrossTeamDeliveries.delete(teamName);
    for (const key of [...this.workSyncRetryAfter.keys()]) {
      if (key.startsWith(`${teamName}\0`)) this.workSyncRetryAfter.delete(key);
    }
  }

  private async run(teamName: string, options: NativeLeadInboxRelayOptions): Promise<number> {
    const run = this.deps.runs.find(teamName);
    if (!run || !this.deps.runs.isLive(run.identity)) return 0;
    const snapshot = this.deps.snapshot(teamName);
    if (snapshot.desired !== 'running') return 0;
    const lead = Object.values(snapshot.members).find(
      (member) => member.role === 'lead' && member.membership === 'configured'
    );
    if (!lead || (!lead.process && !lead.lane)) return 0;
    if (lead.desired !== 'running' || lead.phase !== 'ready') return 0;
    const leadName = lead.memberName;
    const isStale = (): boolean => {
      const current = this.deps.runs.find(teamName);
      return (
        !current ||
        !this.deps.runs.isLive(current.identity) ||
        current.identity.runId !== snapshot.identity.runId ||
        this.deps.snapshot(teamName).desired !== 'running'
      );
    };

    const relayedIds = this.relayed.get(teamName) ?? new Set<string>();
    let messages: InboxMessage[];
    try {
      messages = (await this.deps.inbox.getMessagesFor(teamName, leadName)).filter(
        (message) => !hasGroupChatEnvelopeMarker(message)
      );
    } catch {
      return 0;
    }
    if (isStale()) return 0;

    const now = (this.deps.now ?? Date.now)();
    const unread = messages
      .filter((message): message is RelayInboxMessage => {
        if (message.read) return false;
        if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
        if (!hasStableInboxMessageId(message)) return false;
        if (relayedIds.has(message.messageId)) return false;
        return (this.workSyncRetryAfter.get(`${teamName}\0${message.messageId}`) ?? 0) <= now;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (unread.length === 0) return 0;

    const { silentIdleIds, passiveIdleIds, coarseNonIdleNoiseIds } =
      getLeadInboxRelayNoiseIds(unread);
    const suppression = createCrossTeamLeadSuppressionState({
      leadInboxMessages: messages,
      pendingReplies: this.pendingCrossTeamReplies,
      teamName,
      now,
      ttlMs: RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
    });
    const isOwnOutboundReply = (message: InboxMessage): boolean =>
      markCrossTeamReplyToOwnOutbound(message, suppression);
    const wasRecentlyDelivered = (message: InboxMessage): boolean =>
      wasRecentlyDeliveredCrossTeamLeadMessage({
        message,
        recentMessageIds: this.recentCrossTeamDeliveries,
        teamName,
        now,
        ttlMs: RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
      });

    const { permanentlyIgnored, passiveIdleUnread, readOnlyIgnoredIds, remainingUnread } =
      planLeadInboxRelayReadOnlyMessages({
        unread,
        silentIdleIds,
        passiveIdleIds,
        coarseNonIdleNoiseIds,
        isPermanentlyIgnored: (message) =>
          message.source === CROSS_TEAM_SENT_SOURCE ||
          isOwnOutboundReply(message) ||
          wasRecentlyDelivered(message),
      });
    if (permanentlyIgnored.length > 0) {
      await this.commitRead(teamName, leadName, permanentlyIgnored).catch(() => undefined);
      for (const key of suppression.matchedTransientReplyKeys) {
        const [otherTeam, conversationId] = key.split('\0');
        if (otherTeam && conversationId)
          clearPendingCrossTeamReplyExpectation(
            this.pendingCrossTeamReplies,
            teamName,
            otherTeam,
            conversationId
          );
      }
    }
    if (passiveIdleUnread.length > 0)
      await this.commitRead(teamName, leadName, passiveIdleUnread).catch(() => undefined);

    if (isStale()) return 0;

    const runStartedAtMs = Date.parse(snapshot.startedAt);
    const deferredIds = new Set(
      remainingUnread
        .filter((message) =>
          shouldDeferSameTeamMessage({
            message,
            leadName,
            runStartedAtMs,
            nowMs: now,
            runStartSkewMs: SAME_TEAM_RUN_START_SKEW_MS,
            nativeDeliveryGraceMs: SAME_TEAM_NATIVE_DELIVERY_GRACE_MS,
          })
        )
        .map((message) => message.messageId)
    );
    const actionable = selectActionableLeadRelayUnread({
      remainingUnread,
      nativeMatchedMessageIds: new Set(),
      deferredIds,
      permissionRequestIds: new Set(),
    });
    const onlyMessageId = options.onlyMessageId?.trim();
    const recoveryMessage = actionable.find(
      (message) => String(message.messageKind) === 'runtime_recovery_nudge'
    );
    const scoped = onlyMessageId
      ? actionable.filter((message) => message.messageId === onlyMessageId)
      : recoveryMessage
        ? [recoveryMessage]
        : actionable;
    if (scoped.length === 0) {
      if (deferredIds.size > 0) this.schedule(teamName, SAME_TEAM_NATIVE_DELIVERY_GRACE_MS);
      return 0;
    }

    const { batch, replyVisibility, hasPendingFollowUpRelay } = selectLeadInboxRelayBatch({
      actionableUnread: scoped,
      unread: onlyMessageId ? scoped : unread,
      readOnlyIgnoredIds,
      maxRelay: DEFAULT_INBOX_RELAY_BATCH_SIZE,
    });
    const teammates = Object.values(snapshot.members)
      .filter((member) => member.role === 'member' && member.membership === 'configured')
      .map((member) => ({ name: member.memberName, role: member.role }));
    const prompt = buildLeadInboxRelayPrompt({
      teamName,
      leadName,
      batch,
      replyVisibility,
      teammates,
      workSyncControlUrl: await this.deps.controlUrl().catch(() => null),
    });
    if (isStale()) return 0;

    try {
      await this.deps.send(snapshot.identity, prompt);
    } catch (error) {
      this.log(
        `[${teamName}] lead relay send failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return 0;
    }
    // The run may have stopped while stdin was accepting the prompt.
    if (isStale()) return 0;

    const readCommit: typeof batch = [];
    let needsWorkSyncRetry = false;
    for (const message of batch) {
      const retryKey = `${teamName}\0${message.messageId}`;
      if (message.messageKind === 'member_work_sync_nudge') {
        if (!(await this.hasAcceptedLeadWorkSyncReport(teamName, leadName))) {
          this.workSyncRetryAfter.set(retryKey, now + WORK_SYNC_RETRY_COOLDOWN_MS);
          needsWorkSyncRetry = true;
          continue;
        }
      }
      this.workSyncRetryAfter.delete(retryKey);
      relayedIds.add(message.messageId);
      readCommit.push(message);
    }
    this.relayed.set(teamName, trimRelayedMessageIdSet(relayedIds));
    rememberRecentCrossTeamLeadDeliveryMessageIds(
      this.recentCrossTeamDeliveries,
      teamName,
      batch
        .filter((message) => message.source === CROSS_TEAM_SOURCE)
        .map((message) => message.messageId),
      now,
      RECENT_CROSS_TEAM_DELIVERY_TTL_MS
    );
    await this.commitRead(teamName, leadName, readCommit).catch(() => undefined);
    if (needsWorkSyncRetry) this.schedule(teamName, WORK_SYNC_RETRY_COOLDOWN_MS);
    else if (deferredIds.size > 0) this.schedule(teamName, SAME_TEAM_NATIVE_DELIVERY_GRACE_MS);
    else if (hasPendingFollowUpRelay) this.schedule(teamName, RELAY_FOLLOW_UP_DELAY_MS);
    return batch.length;
  }

  private async commitRead(
    teamName: string,
    leadName: string,
    messages: readonly { messageId: string }[]
  ): Promise<void> {
    if (messages.length === 0) return;
    const markRead = this.deps.markRead;
    if (markRead) {
      await markRead(
        teamName,
        leadName,
        messages.map((message) => message.messageId)
      );
      return;
    }
    await markTeamInboxMessagesReadWithDefaults({
      teamsBasePath: this.deps.teamsRoot,
      teamName,
      member: leadName,
      messages: messages.map((message) => ({ messageId: message.messageId })),
    });
  }

  private async hasAcceptedLeadWorkSyncReport(
    teamName: string,
    leadName: string
  ): Promise<boolean> {
    const check = this.deps.hasAcceptedLeadWorkSyncReport;
    if (!check) return false;
    try {
      return await check({ teamName, leadName });
    } catch {
      return false;
    }
  }

  private log(message: string): void {
    this.deps.logger?.debug(message);
  }
}
