import { TEAM_LIFECYCLE_CHANNELS } from '../contracts';

import type { TeamLifecycleReadApi } from '../contracts';
import type { InvokeIpcWithResult } from './createTeamMemberSettingsBridge';

export function createTeamLifecycleBridge(invoke: InvokeIpcWithResult): TeamLifecycleReadApi {
  return {
    getLifecycleSnapshot: (request) => invoke(TEAM_LIFECYCLE_CHANNELS.snapshot, request),
    openLifecycleSubscription: (request) => invoke(TEAM_LIFECYCLE_CHANNELS.subscribe, request),
    readLifecycleSubscription: (id) => invoke(TEAM_LIFECYCLE_CHANNELS.next, id),
    closeLifecycleSubscription: (id) => invoke(TEAM_LIFECYCLE_CHANNELS.close, id),
  };
}
