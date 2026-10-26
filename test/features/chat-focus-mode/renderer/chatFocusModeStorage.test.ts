import {
  getFocusedChatKeysSnapshot,
  setChatFocused,
  subscribeFocusedChats,
} from '@features/chat-focus-mode/renderer/storage/chatFocusModeStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('chatFocusModeStorage', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps focus per chat and notifies subscribers', () => {
    const seen: string[][] = [];
    const unsub = subscribeFocusedChats(() => {
      seen.push([...getFocusedChatKeysSnapshot('robots')]);
    });

    setChatFocused('robots', 'direct:team-lead', true);
    setChatFocused('robots', 'team-feed', true);
    expect([...getFocusedChatKeysSnapshot('robots')]).toEqual(['direct:team-lead', 'team-feed']);
    expect(getFocusedChatKeysSnapshot('other')).toEqual([]);

    setChatFocused('robots', 'direct:team-lead', false);
    expect(seen.at(-1)).toEqual(['team-feed']);
    expect(JSON.parse(localStorage.getItem('team-chat-focus:robots') ?? '[]')).toEqual([
      'team-feed',
    ]);
    unsub();
  });

  it('drops the storage entry when no chat is focused and ignores junk', () => {
    setChatFocused('robots', 'team-feed', true);
    setChatFocused('robots', 'team-feed', false);
    expect(localStorage.getItem('team-chat-focus:robots')).toBeNull();

    localStorage.setItem('team-chat-focus:robots', '[1,"team-feed","team-feed",""]');
    setChatFocused('robots', 'direct:alice', false);
    expect([...getFocusedChatKeysSnapshot('robots')]).toEqual(['team-feed']);
    setChatFocused('', 'team-feed', true);
    expect(getFocusedChatKeysSnapshot('')).toEqual([]);
  });

  it('keeps focus in memory when localStorage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    setChatFocused('robots', 'direct:alice', true);
    expect([...getFocusedChatKeysSnapshot('robots')]).toEqual(['direct:alice']);
  });
});
