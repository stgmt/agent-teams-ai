import { type JSX, useCallback, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { ActivityItem } from '@renderer/components/team/activity/ActivityItem';
import {
  buildMessageContext,
  resolveMessageRenderProps,
} from '@renderer/components/team/activity/activityMessageContext';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';

import { hasFocusRequest } from '../../core/domain/buildFocusThread';
import { useFocusAutoOlder } from '../hooks/useFocusAutoOlder';

import { focusRequestDomId } from './focusDom';

import type { FocusItem, FocusPairItem } from '../../core/domain/buildFocusThread';
import type { TaskIdClickHandler } from '@renderer/utils/taskReferenceUtils';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export interface FocusThreadViewProps {
  items: readonly FocusItem[];
  teamName: string;
  members?: ResolvedTeamMember[];
  teamNames?: string[];
  teamColorByName?: ReadonlyMap<string, string>;
  onTeamClick?: (teamName: string) => void;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onReplyToMessage?: (message: InboxMessage) => void;
  onTaskIdClick?: TaskIdClickHandler;
  /** Older history: focus mode keeps loading it until the chat shows a request. */
  hasMore?: boolean;
  loadingOlder?: boolean;
  /** The last older page was dropped because history changed while it loaded. */
  historyDiscarded?: boolean;
  onLoadOlder?: () => void;
}

type RenderMessage = (message: InboxMessage) => JSX.Element;

const FocusServiceStrip = ({
  messages,
  renderMessage,
}: {
  messages: readonly InboxMessage[];
  renderMessage: RenderMessage;
}): JSX.Element => {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="px-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1 py-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={12} />
        <span>
          {open
            ? t('messages.focus.hideServiceEvents')
            : t('messages.focus.serviceEvents', { count: messages.length })}
        </span>
        <span className="h-px flex-1 bg-[var(--color-border)]" />
      </button>
      {open ? <div className="opacity-70">{messages.map(renderMessage)}</div> : null}
    </div>
  );
};

const FocusRequestCard = ({
  pair,
  renderMessage,
}: {
  pair: FocusPairItem;
  renderMessage: RenderMessage;
}): JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div
      id={pair.request.messageId ? focusRequestDomId(pair.request.messageId) : undefined}
      className="mx-2 my-2 overflow-hidden rounded-lg border border-[var(--color-border)]"
    >
      {renderMessage(pair.request)}
      {pair.replies.map((reply) => (
        <div key={toMessageKey(reply)} className="border-t border-[var(--color-border)]">
          {reply.replyChannel === 'fallback' ? (
            <div className="px-3 pt-1.5 text-[10px] text-[var(--color-text-muted)]">
              {t('messages.focus.fallbackTag')}
            </div>
          ) : null}
          {renderMessage(reply)}
        </div>
      ))}
      {pair.status === 'pending' ? (
        <div className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-3 py-1.5 text-[11px] text-amber-400">
          <Clock size={12} />
          {t('messages.focus.waiting')}
        </div>
      ) : null}
    </div>
  );
};

/** Focus mode body: request → reply cards with service messages folded between them. */
export const FocusThreadView = ({
  items,
  teamName,
  members,
  teamNames,
  teamColorByName,
  onTeamClick,
  onMemberClick,
  onReplyToMessage,
  onTaskIdClick,
  hasMore = false,
  loadingOlder = false,
  historyDiscarded = false,
  onLoadOlder,
}: FocusThreadViewProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const searching = useFocusAutoOlder({
    hasRequest: hasFocusRequest(items),
    hasMore,
    loadingOlder,
    historyDiscarded,
    onLoadOlder,
  });
  const context = useMemo(() => buildMessageContext(members), [members]);
  const handleMemberNameClick = useCallback(
    (name: string) => {
      const member = members?.find((item) => item.name === name || item.agentType === name);
      if (member) onMemberClick?.(member);
    },
    [members, onMemberClick]
  );
  const renderMessage = useCallback<RenderMessage>(
    (message) => {
      const renderProps = resolveMessageRenderProps(message, context);
      return (
        <ActivityItem
          key={toMessageKey(message)}
          message={message}
          teamName={teamName}
          teamNames={teamNames}
          memberRole={renderProps.memberRole}
          memberColor={renderProps.memberColor}
          recipientColor={renderProps.recipientColor}
          memberColorMap={context.colorMap}
          localMemberNames={context.localMemberNames}
          teamColorByName={teamColorByName}
          onTeamClick={onTeamClick}
          onMemberNameClick={onMemberClick ? handleMemberNameClick : undefined}
          onReply={onReplyToMessage}
          onTaskIdClick={onTaskIdClick}
        />
      );
    },
    [
      context,
      handleMemberNameClick,
      onMemberClick,
      onReplyToMessage,
      onTaskIdClick,
      onTeamClick,
      teamColorByName,
      teamName,
      teamNames,
    ]
  );

  if (!items.some((item) => item.kind !== 'service-gap')) {
    return (
      <p role="status" className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
        {searching ? t('messages.focus.searching') : t('messages.focus.empty')}
      </p>
    );
  }
  return (
    <div className="py-1">
      {items.map((item) => {
        if (item.kind === 'pair') {
          return (
            <FocusRequestCard
              key={toMessageKey(item.request)}
              pair={item}
              renderMessage={renderMessage}
            />
          );
        }
        if (item.kind === 'unsolicited-reply') {
          return (
            <div
              key={toMessageKey(item.reply)}
              className="mx-2 my-2 overflow-hidden rounded-lg border border-[var(--color-border)]"
            >
              {renderMessage(item.reply)}
            </div>
          );
        }
        return (
          <FocusServiceStrip
            key={`gap:${toMessageKey(item.messages[0])}`}
            messages={item.messages}
            renderMessage={renderMessage}
          />
        );
      })}
    </div>
  );
};
