import type { TeamRunIdentity, TeamRunRegistryRead } from '../../../contracts';
import type { LifecycleCommands } from '../../../core/application/ports/LifecycleCommands';
import type { MemberAttachReason } from '../../../core/application/ports/MemberRuntimePorts';
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
  commands: Pick<LifecycleCommands, 'restartMember' | 'skipMember'> & {
    detachMember(team: TeamRunIdentity, memberName: string): Promise<void>;
    attachMember(
      team: TeamRunIdentity,
      memberName: string,
      reason?: MemberAttachReason
    ): Promise<void>;
    retryFailedLanes(run: TeamRunIdentity): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  };
  statuses: Pick<TeamLiveStatusQueries, 'memberSpawnStatuses'>;
  detachMemberData?(teamName: string, memberName: string): Promise<void>;
}

/**
 * Member lifecycle surface over native commands. OpenCode secondary lane retry
 * still fails closed; attach/detach use the native registry and data ports.
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
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_restored' | 'member_updated' }
  ): Promise<void> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    await this.deps.commands.attachMember(
      snapshot.identity,
      memberName,
      options?.reason ?? 'member_added'
    );
  }

  async detachLiveRosterMember(teamName: string, memberName: string): Promise<void> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    const member = snapshot.members[memberName];
    if (member?.membership === 'configured') {
      if (!this.deps.detachMemberData)
        throw new Error('Live roster detach data port is not configured');
      await this.deps.commands.detachMember(snapshot.identity, memberName);
    }
    if (!this.deps.detachMemberData)
      throw new Error('Live roster detach data port is not configured');
    await this.deps.detachMemberData(teamName, memberName);
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
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot) throw new Error(`Unknown team: ${teamName}`);
    return this.deps.commands.retryFailedLanes(snapshot.identity);
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
