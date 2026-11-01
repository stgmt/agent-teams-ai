import { hasGroupChatEnvelopeMarker } from '@features/team-group-chats/contracts';
import { markTeamInboxMessagesReadWithDefaults } from '@main/services/team/provisioning/TeamProvisioningInboxPersistence';
import {
  buildMemberInboxRelayPrompt,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  hasStableInboxMessageId,
  type RelayInboxMessage,
  selectMemberInboxRelayBatch,
  splitMemberInboxRelayUnread,
  trimRelayedMessageIdSet,
} from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';

import type {
  TeamLifecycleSnapshot,
  TeamRunIdentity,
  TeamRunRegistryRead,
} from '../../../contracts';
import type { InboxMessage } from '@shared/types';

const WORK_SYNC_RETRY_COOLDOWN_MS = 60_000;

export interface NativeMemberInboxRelayDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  inbox: { getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> };
  /** Writes the forward prompt to the lead, which routes it to the member. */
  send(run: Readonly<TeamRunIdentity>, text: string): Promise<void>;
  teamsRoot: string;
  markRead?(teamName: string, memberName: string, messageIds: readonly string[]): Promise<void>;
  hasAcceptedMemberWorkSyncReport?(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  now?(): number;
  logger?: { debug(message: string): void };
}

/**
 * Native member inbox relay. Mirrors the legacy lead-mediated flow: unread
 * member rows are batched into one "forward to <member>" prompt for the lead,
 * which delivers them through its messaging tool. Direct lane/stdin delivery is
 * not used because the prompt and work-sync protocol are lead-authored.
 */
export class NativeMemberInboxRelay {
  private readonly relayed = new Map<string, Set<string>>();
  private readonly inFlight = new Map<string, Promise<number>>();
  private readonly polling = new Map<string, ReturnType<typeof setInterval>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workSyncRetryAfter = new Map<string, number>();

  constructor(private readonly deps: NativeMemberInboxRelayDependencies) {}

  relay(teamName: string, memberName: string): Promise<number> {
    const key = relayKey(teamName, memberName);
    const previous = this.inFlight.get(key);
    const work = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.run(teamName, memberName);
    })();
    this.inFlight.set(key, work);
    void work
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      });
    return work;
  }

  /** Polls every configured non-lead member of a live team. */
  startPolling(teamName: string, intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
      throw new Error('Member relay polling interval must be a positive integer');
    this.stopPolling(teamName);
    const handle = setInterval(() => {
      // Polling is work on a registered team. A team removed from the registry
      // answers no snapshot, so its poll ends here instead of throwing per tick.
      if (!this.deps.runs.find(teamName)) {
        this.stopPolling(teamName);
        return;
      }
      const snapshot = this.deps.snapshot(teamName);
      for (const member of Object.values(snapshot.members)) {
        if (member.role !== 'member' || member.membership !== 'configured') continue;
        void this.relay(teamName, member.memberName).catch(() => undefined);
      }
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

  reset(teamName: string): void {
    this.stopPolling(teamName);
    for (const key of [...this.relayed.keys()]) {
      if (key.startsWith(`${teamName}\0`)) this.relayed.delete(key);
    }
    for (const [key, handle] of this.timers.entries()) {
      if (!key.startsWith(`${teamName}\0`)) continue;
      clearTimeout(handle);
      this.timers.delete(key);
    }
    for (const key of [...this.workSyncRetryAfter.keys()]) {
      if (key.startsWith(`${teamName}\0`)) this.workSyncRetryAfter.delete(key);
    }
  }

  dispose(): void {
    for (const teamName of [...this.polling.keys()]) this.stopPolling(teamName);
    for (const [key, handle] of this.timers.entries()) {
      clearTimeout(handle);
      this.timers.delete(key);
    }
  }

  private async run(teamName: string, memberName: string): Promise<number> {
    const snapshot = this.deps.snapshot(teamName);
    if (!this.deps.runs.isLive(snapshot.identity) || snapshot.desired !== 'running') return 0;
    const member = snapshot.members[memberName];
    if (
      !member ||
      member.membership !== 'configured' ||
      member.role !== 'member' ||
      member.desired !== 'running' ||
      member.phase !== 'ready'
    )
      return 0;
    const lead = Object.values(snapshot.members).find(
      (candidate) => candidate.role === 'lead' && candidate.membership === 'configured'
    );
    if (!lead?.process || lead.desired !== 'running' || lead.phase !== 'ready') return 0;
    const isStale = (): boolean =>
      !this.deps.runs.isLive(snapshot.identity) ||
      this.deps.snapshot(teamName).identity.runId !== snapshot.identity.runId ||
      this.deps.snapshot(teamName).desired !== 'running';

    const key = relayKey(teamName, memberName);
    const relayedIds = this.relayed.get(key) ?? new Set<string>();
    let messages: InboxMessage[];
    try {
      messages = (await this.deps.inbox.getMessagesFor(teamName, memberName)).filter(
        (message) => !hasGroupChatEnvelopeMarker(message)
      );
    } catch {
      return 0;
    }
    if (isStale()) return 0;

    const now = (this.deps.now ?? Date.now)();
    for (const [key, retryAt] of this.workSyncRetryAfter.entries()) {
      if (retryAt <= now) this.workSyncRetryAfter.delete(key);
    }
    const unread = messages
      .filter((message): message is RelayInboxMessage => {
        if (message.read) return false;
        if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
        if (!hasStableInboxMessageId(message)) return false;
        if (relayedIds.has(message.messageId)) return false;
        return (this.workSyncRetryAfter.get(relayKey(teamName, message.messageId)) ?? 0) <= now;
      })
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (unread.length === 0) return 0;

    const { passiveIdleUnread, actionableUnread, readOnlyIgnoredUnread } =
      splitMemberInboxRelayUnread(unread);
    if (readOnlyIgnoredUnread.length > 0) {
      try {
        await this.commitRead(teamName, memberName, readOnlyIgnoredUnread);
        if (passiveIdleUnread.length > 0)
          this.log(
            `[${teamName}] member relay marked ${passiveIdleUnread.length} passive idle message(s) read for ${memberName}`
          );
      } catch {
        // Best-effort: ignored rows stay unread and are retried by the next pass.
      }
    }
    if (actionableUnread.length === 0) return 0;

    const batch = selectMemberInboxRelayBatch(actionableUnread, DEFAULT_INBOX_RELAY_BATCH_SIZE);
    const prompt = buildMemberInboxRelayPrompt({ memberName, batch });
    try {
      await this.deps.send(snapshot.identity, prompt);
    } catch (error) {
      this.log(
        `[${teamName}] member relay send failed for ${memberName}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return 0;
    }
    if (isStale()) return 0;

    const readCommit: typeof batch = [];
    let needsWorkSyncRetry = false;
    for (const message of batch) {
      const retryKey = relayKey(teamName, message.messageId);
      if (message.messageKind === 'member_work_sync_nudge') {
        if (!(await this.hasAcceptedMemberWorkSyncReport(teamName, memberName))) {
          this.workSyncRetryAfter.set(retryKey, now + WORK_SYNC_RETRY_COOLDOWN_MS);
          needsWorkSyncRetry = true;
          continue;
        }
      }
      this.workSyncRetryAfter.delete(retryKey);
      relayedIds.add(message.messageId);
      readCommit.push(message);
    }
    this.relayed.set(key, trimRelayedMessageIdSet(relayedIds));
    await this.commitRead(teamName, memberName, readCommit).catch(() => undefined);
    if (needsWorkSyncRetry) this.scheduleRetry(teamName, memberName, WORK_SYNC_RETRY_COOLDOWN_MS);
    return batch.length;
  }

  private scheduleRetry(teamName: string, memberName: string, delayMs: number): void {
    const key = relayKey(teamName, memberName);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      this.timers.delete(key);
      void this.relay(teamName, memberName).catch(() => undefined);
    }, delayMs);
    handle.unref?.();
    this.timers.set(key, handle);
  }

  private async hasAcceptedMemberWorkSyncReport(
    teamName: string,
    memberName: string
  ): Promise<boolean> {
    const check = this.deps.hasAcceptedMemberWorkSyncReport;
    if (!check) return false;
    try {
      return await check({ teamName, memberName });
    } catch {
      return false;
    }
  }

  private async commitRead(
    teamName: string,
    memberName: string,
    messages: readonly { messageId: string }[]
  ): Promise<void> {
    if (messages.length === 0) return;
    const markRead = this.deps.markRead;
    if (markRead) {
      await markRead(
        teamName,
        memberName,
        messages.map((message) => message.messageId)
      );
      return;
    }
    await markTeamInboxMessagesReadWithDefaults({
      teamsBasePath: this.deps.teamsRoot,
      teamName,
      member: memberName,
      messages: messages.map((message) => ({ messageId: message.messageId })),
    });
  }

  private log(message: string): void {
    this.deps.logger?.debug(message);
  }
}

function relayKey(teamName: string, memberName: string): string {
  return `${teamName}\0${memberName}`;
}
