import { TEAM_LIFECYCLE_COMMAND_CHANNELS } from '../contracts';

import type { TeamLifecycleCommandApi } from '../contracts';
import type { InvokeIpcWithResult } from './createTeamMemberSettingsBridge';

export function createTeamLifecycleCommandBridge(
  invoke: InvokeIpcWithResult
): TeamLifecycleCommandApi {
  return {
    launchConfiguredTeam: (request) => invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.launch, request),
    stopConfiguredTeam: (request) => invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.stop, request),
    restartConfiguredMember: (request) =>
      invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.restartMember, request),
    skipConfiguredMemberForLaunch: (request) =>
      invoke(TEAM_LIFECYCLE_COMMAND_CHANNELS.skipMember, request),
  };
}
