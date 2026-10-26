import { describe, expect, it } from 'vitest';

import {
  buildDirectUserMessageReplyInstruction,
  buildLeadUserReplyChannelRule,
  buildUserRelayReplyVisibilityLines,
  getLeadUserReplyChannelMode,
  LEAD_USER_REPLY_CHANNEL_ENV,
} from '../../../../src/main/services/team/leadUserReplyChannel';

describe('leadUserReplyChannel', () => {
  it('defaults to the explicit channel and accepts the plain_text rollback switch', () => {
    expect(getLeadUserReplyChannelMode({})).toBe('explicit');
    expect(getLeadUserReplyChannelMode({ [LEAD_USER_REPLY_CHANNEL_ENV]: 'unknown' })).toBe(
      'explicit'
    );
    expect(getLeadUserReplyChannelMode({ [LEAD_USER_REPLY_CHANNEL_ENV]: ' PLAIN_TEXT ' })).toBe(
      'plain_text'
    );
  });

  it('asks the lead to answer direct user messages with SendMessage to "user"', () => {
    const instruction = buildDirectUserMessageReplyInstruction('explicit');
    expect(instruction).toContain('SendMessage to recipient "user"');
    expect(instruction).toContain('internal working log');
  });

  it('keeps the legacy plain-text instructions in plain_text mode', () => {
    expect(buildDirectUserMessageReplyInstruction('plain_text')).toContain(
      'Your text response here is shown to the user'
    );
    expect(buildUserRelayReplyVisibilityLines('plain_text')[0]).toBe(
      'Plain text reply visibility for this batch: user-visible.'
    );
    expect(buildLeadUserReplyChannelRule('plain_text')).toBe('');
  });

  it('adds a reply-channel section to the lead system prompt in explicit mode', () => {
    const rule = buildLeadUserReplyChannelRule('explicit');
    expect(rule).toContain('Reply channel to the human user');
    expect(rule).toContain('SendMessage to "user"');
  });
});
