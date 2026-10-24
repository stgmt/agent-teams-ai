import { useCallback } from 'react';

import { sendOwnerMessage } from './sendOwnerMessage';

import type { ActionMode } from './ActionModeSelector';
import type {
  AttachmentPayload,
  CrossTeamSendRequest,
  CrossTeamSendResult,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
} from '@shared/types';

interface UseMessagesPanelSendOptions {
  readonly teamName: string;
  readonly sendTeamMessage: (
    teamName: string,
    request: SendMessageRequest
  ) => Promise<SendMessageResult>;
  readonly sendCrossTeamMessage: (
    request: CrossTeamSendRequest
  ) => Promise<CrossTeamSendResult | null>;
  readonly onPendingReplyChange: (
    updater: (previous: Record<string, number>) => Record<string, number>
  ) => void;
}

export function useMessagesPanelSend({
  teamName,
  sendTeamMessage,
  sendCrossTeamMessage,
  onPendingReplyChange,
}: UseMessagesPanelSendOptions): {
  handleSend: (
    member: string,
    text: string,
    summary?: string,
    attachments?: AttachmentPayload[],
    actionMode?: ActionMode,
    taskRefs?: TaskRef[],
    messageId?: string
  ) => Promise<SendMessageResult>;
  handleCrossTeamSend: (
    toTeam: string,
    text: string,
    summary?: string,
    actionMode?: ActionMode,
    taskRefs?: TaskRef[],
    toMember?: string,
    messageId?: string
  ) => Promise<CrossTeamSendResult | null>;
} {
  const handleSend = useCallback(
    async (
      member: string,
      text: string,
      summary?: string,
      attachments?: AttachmentPayload[],
      actionMode?: ActionMode,
      taskRefs?: TaskRef[],
      messageId?: string
    ): Promise<SendMessageResult> => {
      return sendOwnerMessage(
        teamName,
        { member, text, summary, attachments, actionMode, taskRefs, messageId },
        { sendTeamMessage, onPendingReplyChange }
      );
    },
    [onPendingReplyChange, sendTeamMessage, teamName]
  );

  const handleCrossTeamSend = useCallback(
    (
      toTeam: string,
      text: string,
      summary?: string,
      actionMode?: ActionMode,
      taskRefs?: TaskRef[],
      toMember?: string,
      messageId?: string
    ) =>
      sendCrossTeamMessage({
        fromTeam: teamName,
        fromMember: 'user',
        toTeam,
        ...(toMember ? { toMember } : {}),
        text,
        taskRefs,
        actionMode,
        summary,
        messageId,
      }),
    [sendCrossTeamMessage, teamName]
  );

  return { handleSend, handleCrossTeamSend };
}
