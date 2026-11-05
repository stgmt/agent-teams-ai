import { useEffect, useState } from 'react';

import { useStore } from '@renderer/store';
import { subscribeTaskActionEvents } from '@renderer/store/team/taskActionInFlight';

import { TeamReviewActionError } from './TeamReviewActionError';

export const TeamKanbanActionError = ({
  teamName,
  error,
}: {
  teamName: string;
  error: string | null;
}): React.JSX.Element => {
  const contextId = useStore((state) => state.activeContextId);
  const [actionErrors, setActionErrors] = useState<{ taskId: string; message: string }[]>([]);

  useEffect(() => {
    setActionErrors([]);
    return subscribeTaskActionEvents((event) => {
      if (event.contextId !== contextId || event.teamName !== teamName) return;
      setActionErrors((previous) => {
        const remaining = previous.filter((item) => item.taskId !== event.taskId);
        return event.type === 'failed' ? [...remaining, event] : remaining;
      });
    });
  }, [contextId, teamName]);

  const messages = [
    ...new Set([error, ...actionErrors.map((item) => item.message)].filter(Boolean)),
  ];
  return (
    <>
      {messages.map((message) => (
        <TeamReviewActionError key={message} error={message} />
      ))}
    </>
  );
};
