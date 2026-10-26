import { describe, expect, it } from 'vitest';

import { getUserReplyRequestIds, readUserReplyLinkFields } from '@shared/utils/userReplyLink';

describe('readUserReplyLinkFields', () => {
  it('keeps valid reply-link fields and dedupes request ids', () => {
    expect(
      readUserReplyLinkFields({
        replyToMessageIds: [' req-1 ', 'req-2', 'req-1', '', 42],
        replyChannel: 'fallback',
        focusOnly: true,
      })
    ).toEqual({ replyToMessageIds: ['req-1', 'req-2'], replyChannel: 'fallback', focusOnly: true });
  });

  it('drops invalid values instead of passing them through', () => {
    expect(
      readUserReplyLinkFields({ replyToMessageIds: 'req-1', replyChannel: 'plain', focusOnly: 'yes' })
    ).toEqual({});
  });
});

describe('getUserReplyRequestIds', () => {
  it('prefers stamped request ids', () => {
    expect(
      getUserReplyRequestIds({ to: 'user', replyToMessageIds: ['req-1'], relayOfMessageId: 'x' })
    ).toEqual(['req-1']);
  });

  it('treats an OpenCode runtime-delivery reply to user as answering its relayed request', () => {
    expect(
      getUserReplyRequestIds({ to: 'user', source: 'runtime_delivery', relayOfMessageId: 'req-9' })
    ).toEqual(['req-9']);
  });

  it('ignores relay copies that are not replies to user', () => {
    expect(
      getUserReplyRequestIds({ to: 'alice', source: 'runtime_delivery', relayOfMessageId: 'req-9' })
    ).toEqual([]);
    expect(getUserReplyRequestIds({ to: 'user', source: 'inbox', relayOfMessageId: 'req-9' })).toEqual(
      []
    );
  });
});
