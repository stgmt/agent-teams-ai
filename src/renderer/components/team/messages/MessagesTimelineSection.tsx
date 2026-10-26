import { type ComponentProps, memo } from 'react';

import { FocusThreadView, type FocusView } from '@features/chat-focus-mode/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';

import { ActivityTimeline } from '../activity/ActivityTimeline';
import { MessageExpandDialog } from '../activity/MessageExpandDialog';

import type { TimelineItem } from '../activity/LeadThoughtsGroup';
import type { MessageActionOwner } from '@renderer/types/messageTaskSeed';

type MessagesTimelineSectionProps = ComponentProps<typeof ActivityTimeline> & {
  hasMore: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  expandedItem: TimelineItem | null;
  actionOwner: MessageActionOwner;
  expandedOwner: MessageActionOwner | null;
  expandedItemKey: string | null;
  onExpandDialogChange: (open: boolean) => void;
  /** Focus mode cards; when set they replace the timeline. */
  focus?: FocusView | null;
};

export const MessagesTimelineSection = memo(function MessagesTimelineSection({
  hasMore,
  loadingOlderMessages,
  onLoadOlderMessages,
  expandedItem,
  actionOwner,
  expandedOwner,
  expandedItemKey,
  onExpandDialogChange,
  focus,
  ...timelineProps
}: MessagesTimelineSectionProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  // Group chats page their own history; the team flag only describes the team feed.
  const historyDiscarded = useStore((s) =>
    focus && !focus.group
      ? (s.teamMessagesByName[timelineProps.teamName]?.historyReloadRequired ?? false)
      : false
  );
  const history = (prepare?: () => void): React.ReactNode =>
    hasMore ? (
      <div className="flex justify-center py-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-text-muted"
          aria-busy={loadingOlderMessages}
          disabled={loadingOlderMessages}
          onClick={() => {
            prepare?.();
            onLoadOlderMessages();
          }}
        >
          {t('messages.actions.loadOlder')}
        </Button>
      </div>
    ) : null;
  if (focus) {
    return (
      <>
        {history()}
        <FocusThreadView
          key={focus.key}
          items={focus.items}
          teamName={timelineProps.teamName}
          members={timelineProps.members}
          teamNames={timelineProps.teamNames}
          teamColorByName={timelineProps.teamColorByName}
          onTeamClick={timelineProps.onTeamClick}
          onMemberClick={timelineProps.onMemberClick}
          onReplyToMessage={timelineProps.onReplyToMessage}
          onTaskIdClick={timelineProps.onTaskIdClick}
          hasMore={hasMore}
          loadingOlder={loadingOlderMessages}
          historyDiscarded={historyDiscarded}
          onLoadOlder={onLoadOlderMessages}
        />
      </>
    );
  }
  return (
    <>
      <ActivityTimeline {...timelineProps} historyControl={history} />
      {timelineProps.presentation !== 'conversation' && history()}
      <MessageExpandDialog
        expandedItem={expandedItem}
        actionOwner={actionOwner}
        expandedOwner={expandedOwner}
        open={expandedItemKey !== null}
        onOpenChange={onExpandDialogChange}
        teamName={timelineProps.teamName}
        members={timelineProps.members}
        onCreateTaskFromMessage={timelineProps.onCreateTaskFromMessage}
        onReplyToMessage={timelineProps.onReplyToMessage}
        revisionMessageId={timelineProps.revisionMessageId}
        onReviseMessage={timelineProps.onReviseMessage}
        onMemberClick={timelineProps.onMemberClick}
        onTaskIdClick={timelineProps.onTaskIdClick}
        onRestartTeam={timelineProps.onRestartTeam}
        teamNames={timelineProps.teamNames}
        teamColorByName={timelineProps.teamColorByName}
        onTeamClick={timelineProps.onTeamClick}
      />
    </>
  );
});
