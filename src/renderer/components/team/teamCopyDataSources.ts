import { buildCopiedTeamMembers } from './teamCopyData';

import type { TeamCopyData } from './dialogs/CreateTeamDialog.types';
import type { TeamCreateRequest, TeamViewSnapshot } from '@shared/types';

export function buildTeamCopyDataFromSavedRequest(
  teamName: string,
  savedRequest: TeamCreateRequest
): TeamCopyData {
  return {
    teamName,
    runtimeSelectionVersion: savedRequest.runtimeSelectionVersion,
    specProject: savedRequest.specProject,
    specSlug: savedRequest.specSlug,
    description: savedRequest.description,
    color: savedRequest.color,
    cwd: savedRequest.cwd,
    prompt: savedRequest.prompt,
    providerId: savedRequest.providerId,
    model: savedRequest.model,
    effort: savedRequest.effort,
    fastMode: savedRequest.fastMode,
    syncModelsWithLead: savedRequest.syncModelsWithLead,
    limitContext: savedRequest.limitContext,
    skipPermissions: savedRequest.skipPermissions,
    members: buildCopiedTeamMembers(savedRequest.members),
  };
}

export function buildTeamCopyDataFromTeamData(
  teamName: string,
  data: TeamViewSnapshot
): TeamCopyData {
  return {
    teamName,
    specProject: data.config.specProject,
    specSlug: data.config.specSlug,
    description: data.config.description,
    color: data.config.color,
    cwd: data.config.projectPath,
    members: buildCopiedTeamMembers(data.config.members, data.members),
  };
}
