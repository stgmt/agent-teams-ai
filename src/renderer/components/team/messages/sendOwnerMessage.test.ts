import { noteOwnerMessageSent } from '@features/team-downtime-notice/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sendOwnerMessage } from './sendOwnerMessage';

import type { SendMessageResult } from '@shared/types';

// РИСК: подменён только вход в фичу простоя (`noteOwnerMessageSent`): здесь проверяется, когда
// его зовут. Что он решает по живой команде, проверено в тестах самой фичи на настоящем хранилище.
vi.mock('@features/team-downtime-notice/renderer', () => ({
  noteOwnerMessageSent: vi.fn(),
}));

const TEAM = 'my-team';
const request = { member: 'team-lead', text: 'hello' };

type PendingUpdater = (previous: Record<string, number>) => Record<string, number>;

function makeDeps(sendTeamMessage: () => Promise<SendMessageResult>): {
  sendTeamMessage: ReturnType<typeof vi.fn<() => Promise<SendMessageResult>>>;
  onPendingReplyChange: ReturnType<typeof vi.fn<(updater: PendingUpdater) => void>>;
} {
  return {
    sendTeamMessage: vi.fn(sendTeamMessage),
    onPendingReplyChange: vi.fn<(updater: PendingUpdater) => void>(),
  };
}

describe('sendOwnerMessage', () => {
  beforeEach(() => {
    vi.mocked(noteOwnerMessageSent).mockClear();
  });

  it('sends through the store action and marks the member as awaiting a reply', async () => {
    const result = { deliveredToInbox: true, messageId: 'm1' } as SendMessageResult;
    const deps = makeDeps(async () => result);

    await expect(sendOwnerMessage(TEAM, request, deps)).resolves.toBe(result);

    expect(deps.sendTeamMessage).toHaveBeenCalledWith(TEAM, request);
    expect(deps.onPendingReplyChange).toHaveBeenCalledTimes(1);
    const mark = deps.onPendingReplyChange.mock.calls[0][0];
    expect(Object.keys(mark({}))).toEqual(['team-lead']);
  });

  it('NM-S13: tells the downtime notice once the team accepted the message', async () => {
    const deps = makeDeps(async () => ({ deliveredToInbox: true }) as SendMessageResult);

    await sendOwnerMessage(TEAM, request, deps);

    expect(noteOwnerMessageSent).toHaveBeenCalledTimes(1);
    expect(noteOwnerMessageSent).toHaveBeenCalledWith(TEAM);
  });

  it('a failed send clears the pending marker, tells nobody and rethrows', async () => {
    const deps = makeDeps(async () => {
      throw new Error('send failed');
    });

    await expect(sendOwnerMessage(TEAM, request, deps)).rejects.toThrow('send failed');

    expect(noteOwnerMessageSent).not.toHaveBeenCalled();
    const [mark, clear] = deps.onPendingReplyChange.mock.calls.map(([updater]) => updater);
    expect(clear(mark({}))).toEqual({});
  });
});
