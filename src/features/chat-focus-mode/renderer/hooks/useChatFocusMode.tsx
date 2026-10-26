import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from 'react';

import { type ConversationScope, conversationScopeKey } from '@features/team-direct-chats';

import {
  buildFocusThread,
  type FocusItem,
  summarizeFocusThread,
} from '../../core/domain/buildFocusThread';
import {
  getFocusedChatKeysSnapshot,
  setChatFocused,
  subscribeFocusedChats,
} from '../storage/chatFocusModeStorage';
import { focusRequestDomId } from '../ui/focusDom';
import { FocusModeToggle } from '../ui/FocusModeToggle';

import type { InboxMessage } from '@shared/types';

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

export interface ChatFocusModeArgs {
  teamName: string;
  scope: ConversationScope;
  leadNames: readonly string[];
  /** Messages of the open conversation. */
  messages: readonly InboxMessage[];
  /** A conversation thread is open; the toggle shows only then. */
  thread: boolean;
  /** Other header actions to keep next to the toggle. */
  actions?: ReactNode;
}

export interface FocusView {
  /** Conversation scope key; the view restarts its history search when it changes. */
  key: string;
  /** Group chats page their history apart from the team feed. */
  group: boolean;
  items: FocusItem[];
}

export interface ChatFocusMode {
  /** Focus cards to render instead of the timeline, or null in the normal view. */
  view: FocusView | null;
  headerActions: ReactNode;
}

function scrollToRequest(message: InboxMessage | null): void {
  if (!message?.messageId) return;
  const element = document.getElementById(focusRequestDomId(message.messageId));
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Per-chat focus mode: shows only the user's requests and the replies to them. */
export function useChatFocusMode({
  teamName,
  scope,
  leadNames,
  messages,
  thread,
  actions,
}: ChatFocusModeArgs): ChatFocusMode {
  const scopeKey = conversationScopeKey(scope);
  const focusedKeys = useSyncExternalStore(
    subscribeFocusedChats,
    () => getFocusedChatKeysSnapshot(teamName),
    () => EMPTY_KEYS
  );
  const active = thread && focusedKeys.includes(scopeKey);
  const items = useMemo(
    () => (active ? buildFocusThread(messages, { scope, leadNames }) : null),
    [active, leadNames, messages, scope]
  );
  const summary = useMemo(() => (items ? summarizeFocusThread(items) : null), [items]);
  const group = scope.kind === 'group';
  const view = useMemo(
    () => (items ? { key: scopeKey, group, items } : null),
    [group, items, scopeKey]
  );
  const toggle = useCallback(
    () => setChatFocused(teamName, scopeKey, !active),
    [active, scopeKey, teamName]
  );
  const earliestPending = summary?.earliestPendingRequest ?? null;

  const headerActions = thread ? (
    <>
      <FocusModeToggle
        active={active}
        pendingCount={summary?.pendingCount ?? 0}
        onToggle={toggle}
        onJumpToPending={() => scrollToRequest(earliestPending)}
      />
      {actions}
    </>
  ) : (
    actions
  );
  return { view, headerActions };
}
