import { boundLiveLeadProcessMessage } from '@main/services/team/provisioning/TeamProvisioningProgressBuffers';

import type { TeamRunIdentity } from '../../../contracts';
import type { InboxMessage } from '@shared/types';

interface Entry {
  identityKey: string;
  messages: InboxMessage[];
}

const LIVE_MESSAGE_CACHE_LIMIT = 100;

function identityKey(run: Readonly<TeamRunIdentity>): string {
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
  ]);
}

/** Live lead-message projection scoped to one native run and cleared on release. */
export class NativeLeadLiveMessageStore {
  private readonly byTeam = new Map<string, Entry>();

  push(run: Readonly<TeamRunIdentity>, message: InboxMessage, sessionId: string | null): void {
    const key = identityKey(run);
    let entry = this.byTeam.get(run.teamName);
    if (!entry || entry.identityKey !== key) entry = { identityKey: key, messages: [] };

    const bounded = boundLiveLeadProcessMessage({
      ...message,
      ...(!message.leadSessionId && sessionId ? { leadSessionId: sessionId } : {}),
    });
    const id = typeof bounded.messageId === 'string' ? bounded.messageId.trim() : '';
    const existingIndex = id
      ? entry.messages.findIndex((candidate) => (candidate.messageId ?? '').trim() === id)
      : -1;
    if (existingIndex >= 0) entry.messages[existingIndex] = bounded;
    else entry.messages.push(bounded);
    if (entry.messages.length > LIVE_MESSAGE_CACHE_LIMIT)
      entry.messages.splice(0, entry.messages.length - LIVE_MESSAGE_CACHE_LIMIT);
    this.byTeam.set(run.teamName, entry);
  }

  read(run: Readonly<TeamRunIdentity>, sessionId: string | null): InboxMessage[] {
    const entry = this.byTeam.get(run.teamName);
    if (!entry || entry.identityKey !== identityKey(run)) return [];
    return entry.messages.map((message) =>
      !message.leadSessionId && sessionId
        ? { ...message, leadSessionId: sessionId }
        : { ...message }
    );
  }

  clear(run: Readonly<TeamRunIdentity>): void {
    const entry = this.byTeam.get(run.teamName);
    if (entry?.identityKey === identityKey(run)) this.byTeam.delete(run.teamName);
  }
}
