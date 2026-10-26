import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isThoughtProtocolNoise } from '@shared/utils/inboxNoise';
import { isTeamInternalControlMessageText } from '@shared/utils/teamInternalControlMessages';

import { getLeadUserReplyChannelMode } from '../leadUserReplyChannel';

import type { InboxMessage, UserReplyChannel } from '@shared/types';

/**
 * Tracks user requests the team lead has not answered yet, so main can link the lead's reply
 * to "user" back to them (`replyToMessageIds`) and promote the lead's text to a fallback reply
 * when a request ends without an explicit SendMessage to "user".
 *
 * The CLI does not report when it consumes a stdin message, so turns are counted by terminal
 * results: a request written while the lead was busy belongs to a later turn than the one
 * running, and only a turn that started after the request may answer it with a fallback.
 */

type UserRequestOwner = 'direct' | 'relay';

interface OpenUserRequest {
  messageId: string;
  owner: UserRequestOwner;
  /** Completed turns needed before the turn that may answer this request starts. */
  minCompletedTurns: number;
}

interface LeadTurnText {
  text: string;
  turn: number;
}

interface LeadUserReplyTrackerState {
  openRequests: OpenUserRequest[];
  completedTurns: number;
  lastText: LeadTurnText | null;
  /** Requests the latest reply answered; later replies (e.g. the result after an ack) follow them. */
  lastAnsweredIds: string[];
}

const MAX_OPEN_REQUESTS = 50;
const trackerStates = new WeakMap<object, LeadUserReplyTrackerState>();

function getState(run: object): LeadUserReplyTrackerState {
  let state = trackerStates.get(run);
  if (!state) {
    state = { openRequests: [], completedTurns: 0, lastText: null, lastAnsweredIds: [] };
    trackerStates.set(run, state);
  }
  return state;
}

function addOpenRequest(state: LeadUserReplyTrackerState, request: OpenUserRequest): void {
  if (!request.messageId) return;
  state.openRequests = state.openRequests.filter((open) => open.messageId !== request.messageId);
  state.openRequests.push(request);
  if (state.openRequests.length > MAX_OPEN_REQUESTS) {
    state.openRequests.splice(0, state.openRequests.length - MAX_OPEN_REQUESTS);
  }
}

/** A user message was written straight to the lead's stdin. */
export function registerDirectUserRequest(run: object, messageId: string): void {
  const state = getState(run);
  const leadBusy = (run as { leadActivityState?: unknown }).leadActivityState === 'active';
  addOpenRequest(state, {
    messageId: messageId.trim(),
    owner: 'direct',
    minCompletedTurns: state.completedTurns + (leadBusy ? 1 : 0),
  });
}

/** The stdin write of a direct request failed; the message goes through the inbox instead. */
export function forgetUserRequest(run: object, messageId: string): void {
  const state = trackerStates.get(run);
  if (!state) return;
  state.openRequests = state.openRequests.filter((open) => open.messageId !== messageId);
}

/** User-originated rows of a lead inbox relay batch. The relay flow owns their fallback. */
export function registerRelayUserRequests(run: object, messageIds: readonly string[]): void {
  const state = getState(run);
  for (const messageId of messageIds) {
    addOpenRequest(state, {
      messageId: messageId.trim(),
      owner: 'relay',
      minCompletedTurns: state.completedTurns,
    });
  }
}

/** Forgets relay requests once the relay flow has finished with them. */
export function closeRelayUserRequests(run: object, messageIds: readonly string[]): void {
  const state = trackerStates.get(run);
  if (!state) return;
  const ids = new Set(messageIds);
  state.openRequests = state.openRequests.filter(
    (open) => open.owner !== 'relay' || !ids.has(open.messageId)
  );
}

/** Full text of the lead's coalesced stream buffer, if any. */
export function readLiveLeadTextBuffer(buffer: unknown): string | null {
  if (!buffer || typeof buffer !== 'object') return null;
  const text = (buffer as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text : null;
}

/** Latest visible lead text of the current turn; the fallback reply candidate. */
export function recordLeadTurnText(run: object, text: string): void {
  const state = getState(run);
  state.lastText = { text, turn: state.completedTurns };
}

function isReachedBy(open: OpenUserRequest, turn: number): boolean {
  return open.owner === 'relay' || turn >= open.minCompletedTurns;
}

/**
 * The lead sent SendMessage to "user": it answers every open request the running turn has
 * already received. Requests queued behind the running turn stay open. A reply with no such
 * request follows up the requests answered last, e.g. the result after an acknowledgement.
 */
export function takeRequestIdsForExplicitReply(run: object): string[] {
  const state = trackerStates.get(run);
  if (!state) return [];
  const turn = state.completedTurns;
  const answered = state.openRequests.filter((open) => isReachedBy(open, turn));
  if (answered.length === 0) return [...state.lastAnsweredIds];
  state.openRequests = state.openRequests.filter((open) => !isReachedBy(open, turn));
  state.lastAnsweredIds = answered.map((open) => open.messageId);
  return [...state.lastAnsweredIds];
}

function toFallbackReplyText(text: string | undefined): string | null {
  if (!text) return null;
  const clean = stripAgentBlocks(text).trim();
  if (!clean) return null;
  if (isThoughtProtocolNoise(clean) || isTeamInternalControlMessageText(clean)) return null;
  return clean;
}

export interface CompleteLeadTurnResult {
  /** Fallback reply to persist, or null when the turn answered nothing or left no text. */
  fallbackReply: InboxMessage | null;
  /** Direct requests this turn closed without any reply text. */
  unansweredRequestIds: string[];
}

/** A lead turn ended (terminal result). Closes the direct requests this turn was answering. */
export function completeLeadTurn(
  run: object,
  input: {
    leadName: string;
    runId: string;
    nowIso: string;
    nowMs: number;
    /** `explicit` when plain text is the reply channel (legacy mode). */
    replyChannel?: UserReplyChannel;
  }
): CompleteLeadTurnResult {
  const state = getState(run);
  const turn = state.completedTurns;
  const answered = state.openRequests.filter(
    (open) => open.owner === 'direct' && turn >= open.minCompletedTurns
  );
  const text = state.lastText?.turn === turn ? state.lastText.text : undefined;
  state.completedTurns += 1;
  state.lastText = null;
  if (answered.length === 0) return { fallbackReply: null, unansweredRequestIds: [] };

  const answeredIds = new Set(answered.map((open) => open.messageId));
  state.openRequests = state.openRequests.filter((open) => !answeredIds.has(open.messageId));
  state.lastAnsweredIds = [...answeredIds];
  const replyText = toFallbackReplyText(text);
  if (!replyText) return { fallbackReply: null, unansweredRequestIds: [...answeredIds] };

  return {
    fallbackReply: {
      from: input.leadName,
      to: 'user',
      text: replyText,
      timestamp: input.nowIso,
      read: true,
      summary: replyText.length > 60 ? `${replyText.slice(0, 57)}...` : replyText,
      messageId: `lead-reply-fallback-${input.runId}-${input.nowMs}`,
      source: 'lead_process',
      replyToMessageIds: [...answeredIds],
      replyChannel: input.replyChannel ?? 'fallback',
      focusOnly: true,
    },
    unansweredRequestIds: [],
  };
}

export interface FinishLeadUserReplyTurnPorts {
  leadName: string;
  nowIso(): string;
  nowMs(): number;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void;
  emitInboxChange(teamName: string, detail: string): void;
  logger: { warn(message: string): void };
}

/** Turn end hook: persists a fallback reply when the lead answered a request only with text. */
export function finishLeadUserReplyTurn(
  run: { teamName: string; runId: string },
  ports: FinishLeadUserReplyTurnPorts
): void {
  const legacyPlainText = getLeadUserReplyChannelMode() === 'plain_text';
  const result = completeLeadTurn(run, {
    leadName: ports.leadName,
    runId: run.runId,
    nowIso: ports.nowIso(),
    nowMs: ports.nowMs(),
    replyChannel: legacyPlainText ? 'explicit' : 'fallback',
  });
  if (result.unansweredRequestIds.length > 0) {
    ports.logger.warn(
      `[${run.teamName}] lead turn ended without a reply to user request(s) ${result.unansweredRequestIds.join(', ')}`
    );
  }
  const reply = result.fallbackReply;
  if (!reply) return;
  if (!legacyPlainText) {
    ports.logger.warn(
      `[${run.teamName}] lead answered user request(s) ${reply.replyToMessageIds?.join(', ')} without SendMessage to "user"; stored a fallback reply`
    );
  }
  ports.pushLiveLeadProcessMessage(run.teamName, reply);
  ports.persistSentMessage(run.teamName, reply);
  ports.emitInboxChange(run.teamName, 'sentMessages.json');
}
