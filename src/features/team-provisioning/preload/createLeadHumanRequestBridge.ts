import { TEAM_SUBMIT_HUMAN_REQUEST } from '../contracts';

import type { LeadHumanRequestApi } from '../contracts';
import type { InvokeIpcWithResult } from './createTeamMemberSettingsBridge';

export function createLeadHumanRequestBridge(invoke: InvokeIpcWithResult): LeadHumanRequestApi {
  return {
    submitHumanRequest: (request) => invoke(TEAM_SUBMIT_HUMAN_REQUEST, request),
  };
}
