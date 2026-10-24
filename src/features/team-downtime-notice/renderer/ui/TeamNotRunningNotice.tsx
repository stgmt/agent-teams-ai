import {
  type TeamNotRunningNoticeParams,
  useTeamNotRunningNotice,
} from '../hooks/useTeamNotRunningNotice';

import { TeamNotRunningDialog } from './TeamNotRunningDialog';

/** Host of the "team is not running" dialog: decides when to show it, renders it. */
export function TeamNotRunningNotice(
  props: Readonly<TeamNotRunningNoticeParams>
): React.JSX.Element {
  const dialog = useTeamNotRunningNotice(props);
  return <TeamNotRunningDialog teamName={props.teamName} {...dialog} />;
}
