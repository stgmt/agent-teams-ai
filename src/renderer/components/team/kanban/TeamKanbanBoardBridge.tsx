import { type ComponentProps, memo } from 'react';

import { RoleActivationPlanner } from '@features/member-work-sync/renderer';
import { useStore } from '@renderer/store';

import { KanbanBoard } from './KanbanBoard';

type TeamKanbanBoardBridgeProps = Omit<
  ComponentProps<typeof KanbanBoard>,
  'activeTaskLogActivity' | 'contextId'
>;

export const TeamKanbanBoardBridge = memo(function TeamKanbanBoardBridge({
  teamName,
  ...props
}: TeamKanbanBoardBridgeProps): React.JSX.Element {
  const contextId = useStore((s) => s.activeContextId);
  const activeTaskLogActivity = useStore((s) => s.activeTaskLogActivityByTeam[teamName]);
  const data = useStore((s) => (s.selectedTeamName === teamName ? s.selectedTeamData : null));
  const currentRuntime = useStore((s) => s.teamAgentRuntimeByTeam[teamName]);

  return (
    <>
      {data && (
        <RoleActivationPlanner
          key={`${contextId}:${teamName}`}
          teamName={teamName}
          teamAlive={data.isAlive === true}
          tasks={data.tasks}
          members={props.members}
          kanbanState={data.kanbanState}
          currentRuntime={currentRuntime}
        />
      )}
      <KanbanBoard
        {...props}
        contextId={contextId}
        teamName={teamName}
        activeTaskLogActivity={activeTaskLogActivity}
      />
    </>
  );
});
