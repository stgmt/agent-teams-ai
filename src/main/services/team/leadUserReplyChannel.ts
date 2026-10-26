/**
 * How the team lead answers the human user.
 *
 * - `explicit` (default): the lead answers every user request with SendMessage to "user".
 *   Plain assistant text is the lead's working log; main promotes it to a fallback reply only
 *   when a user request ends without an explicit answer.
 * - `plain_text`: legacy behavior, the lead's plain text is the reply.
 *
 * Rollback switch: AGENT_TEAMS_LEAD_USER_REPLY_CHANNEL=plain_text.
 */
export type LeadUserReplyChannelMode = 'explicit' | 'plain_text';

export const LEAD_USER_REPLY_CHANNEL_ENV = 'AGENT_TEAMS_LEAD_USER_REPLY_CHANNEL';

export function getLeadUserReplyChannelMode(
  env: Record<string, string | undefined> = process.env
): LeadUserReplyChannelMode {
  return env[LEAD_USER_REPLY_CHANNEL_ENV]?.trim().toLowerCase() === 'plain_text'
    ? 'plain_text'
    : 'explicit';
}

/** Instruction line for a user message written straight to the lead's stdin. */
export function buildDirectUserMessageReplyInstruction(
  mode: LeadUserReplyChannelMode = getLeadUserReplyChannelMode()
): string {
  if (mode === 'plain_text') {
    return 'IMPORTANT: Your text response here is shown to the user in the Messages panel. Always include a brief human-readable reply. Do NOT respond with only an agent-only block.';
  }
  return 'IMPORTANT: Answer this message with SendMessage to recipient "user"; that message is the reply the user reads. Your plain text output is your internal working log, not a reply. End your work on this request with one SendMessage to "user" that answers it as a standalone message. If the work will take a while, you may send a short acknowledgement first and the final answer later. Do NOT respond with only an agent-only block.';
}

/** Reply-visibility lines of a lead inbox relay batch that originated from the human user. */
export function buildUserRelayReplyVisibilityLines(
  mode: LeadUserReplyChannelMode = getLeadUserReplyChannelMode()
): string[] {
  if (mode === 'plain_text') {
    return [
      `Plain text reply visibility for this batch: user-visible.`,
      `These inbox rows originated from the human user, so a concise plain text reply is allowed and will be shown to the user.`,
      `If a visible reply is needed for a teammate or another team, use the appropriate messaging tool; plain text is only for the human response.`,
    ];
  }
  return [
    `Reply channel for this batch: these inbox rows originated from the human user.`,
    `Answer them with SendMessage to recipient "user"; that message is the reply the user reads. Plain text is your internal working log and is used only as a fallback reply when you send none.`,
    `If a visible reply is needed for a teammate or another team, use the appropriate messaging tool.`,
  ];
}

/** Lead system prompt section about the reply channel; empty in legacy mode. */
export function buildLeadUserReplyChannelRule(
  mode: LeadUserReplyChannelMode = getLeadUserReplyChannelMode()
): string {
  if (mode === 'plain_text') return '';
  return [
    'Reply channel to the human user (CRITICAL):',
    `- Answer the user's requests with SendMessage to recipient "user". The user reads those messages; your plain text output is an internal working log.`,
    '- Every user request must end with a SendMessage to "user" that answers it as a standalone message: the user may read only that message.',
    '- A short acknowledgement first is fine when the work takes a while; send the final answer to "user" when it is ready.',
    '- Do NOT send status narration about teammates or the board to "user" unless it answers a user request or the user must act on it.',
  ].join('\n');
}
