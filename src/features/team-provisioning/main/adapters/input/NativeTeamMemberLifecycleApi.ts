import type { TeamRunRegistryRead } from '../../../contracts';
import type { LifecycleCommands } from '../../../core/application/ports/LifecycleCommands';
import type { TeamLiveStatusQueries } from '../../composition/createBoundTeamLiveStatusQueries';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TeamMemberLifecycleApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
} from '@shared/types';

interface Dependencies {
  owner: Readonly<AppConnectionContext>;
  runs: Pick<TeamRunRegistryRead, 'find'>;
  commands: Pick<LifecycleCommands, 'restartMember' | 'skipMember'>;
  statuses: Pick<TeamLiveStatusQueries, 'memberSpawnStatuses'>;
}

/**
 * Member lifecycle surface over native commands. Attach/detach and OpenCode
 * secondary-lane retry have no native command yet and fail closed.
 */
export class NativeTeamMemberLifecycleApi implements TeamMemberLifecycleApi {
  constructor(private readonly deps: Dependencies) {}

  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot> {
    return this.deps.statuses.memberSpawnStatuses({ teamName });
  }

  async runLiveRosterMutation(_teamName: string, mutation: () => Promise<void>): Promise<void> {
    await mutation();
  }

  async tryRunLiveRosterMutation(
    _teamName: string,
    mutation: () => Promise<void>
  ): Promise<boolean> {
    await mutation();
    return true;
  }

  async attachLiveRosterMember(
    _teamName: string,
    _memberName: string,
    _options?: { reason?: 'member_added' | 'member_restored' | 'member_updated' }
  ): Promise<void> {
    throw new Error('Live roster attach is not migrated');
  }

  async detachLiveRosterMember(_teamName: string, _memberName: string): Promise<void> {
    throw new Error('Live roster detach is not migrated');
  }

  async restartMember(
    teamName: string,
    memberName: string,
    expectedSecondary?: boolean
  ): Promise<void> {
    if (expectedSecondary) throw new Error('OpenCode secondary lane retry is not migrated');
    await this.deps.commands.restartMember(this.target(teamName, memberName));
  }

  async retryFailedOpenCodeSecondaryLanes(
    _teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    throw new Error('OpenCode secondary lane retry is not migrated');
  }

  async skipMemberForLaunch(teamName: string, memberName: string): Promise<void> {
    await this.deps.commands.skipMember(this.target(teamName, memberName));
  }

  private target(teamName: string, memberName: string) {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    const member = snapshot.members[memberName];
    if (!member) throw new Error(`Unknown member: ${memberName}`);
    return Object.freeze({
      ...this.deps.owner,
      teamName,
      runId: snapshot.identity.runId,
      memberName,
      generation: member.generation,
    });
  }
}
