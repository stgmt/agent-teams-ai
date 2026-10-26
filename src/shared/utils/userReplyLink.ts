import type { UserReplyChannel, UserReplyLinkFields } from '@shared/types/userReplyLink';

function normalizeReplyToMessageIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : undefined;
}

function normalizeReplyChannel(value: unknown): UserReplyChannel | undefined {
  return value === 'explicit' || value === 'fallback' ? value : undefined;
}

/**
 * Reads the reply-link fields from an untrusted persisted row.
 * Only valid, present fields are returned so the result can be spread into a message.
 */
export function readUserReplyLinkFields(value: object): UserReplyLinkFields {
  const row = value as Record<string, unknown>;
  const replyToMessageIds = normalizeReplyToMessageIds(row.replyToMessageIds);
  const replyChannel = normalizeReplyChannel(row.replyChannel);
  return {
    ...(replyToMessageIds ? { replyToMessageIds } : {}),
    ...(replyChannel ? { replyChannel } : {}),
    ...(row.focusOnly === true ? { focusOnly: true } : {}),
  };
}

/** Request ids a reply to "user" answers, including OpenCode runtime-delivery replies. */
export function getUserReplyRequestIds(message: {
  to?: string;
  source?: string;
  replyToMessageIds?: string[];
  relayOfMessageId?: string;
}): string[] {
  if (message.replyToMessageIds?.length) return message.replyToMessageIds;
  const relayOf = message.relayOfMessageId?.trim();
  if (relayOf && message.source === 'runtime_delivery' && message.to?.trim() === 'user') {
    return [relayOf];
  }
  return [];
}
