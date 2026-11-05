import type { MemberStartAdmission, TeamLifecycleSnapshot, TeamRunIdentity } from './lifecycle';
import type { UpdateMemberSettingsRequest, UpdateMemberSettingsResult } from './memberSettings';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TeamProvisioningProgress } from '@shared/types/team';

export interface TeamProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamMemberSettingsApi {
  updateMemberSettings(request: UpdateMemberSettingsRequest): Promise<UpdateMemberSettingsResult>;
}

export interface TeamLifecycleQuery {
  expectedContext: Readonly<AppConnectionContext>;
  teamName: string;
}

export interface TeamLifecycleStopRequest extends TeamLifecycleQuery {
  runId: string;
}

export interface TeamLifecycleMemberRequest extends TeamLifecycleStopRequest {
  memberName: string;
  generation: number;
}

export interface TeamLifecycleCommandApi {
  launchConfiguredTeam(
    request: TeamLifecycleQuery
  ): Promise<Readonly<{ run: Readonly<TeamRunIdentity> }>>;
  stopConfiguredTeam(request: TeamLifecycleStopRequest): Promise<void>;
  restartConfiguredMember(request: TeamLifecycleMemberRequest): Promise<MemberStartAdmission>;
  skipConfiguredMemberForLaunch(request: TeamLifecycleMemberRequest): Promise<void>;
}

export type TeamLifecycleReadResult = IteratorResult<Readonly<TeamLifecycleSnapshot>, undefined>;

/** Plain IPC values only; async iterators stay on their owning side of contextBridge. */
export interface TeamLifecycleReadApi {
  getLifecycleSnapshot(
    request: TeamLifecycleQuery
  ): Promise<Readonly<TeamLifecycleSnapshot> | null>;
  openLifecycleSubscription(request: TeamLifecycleQuery): Promise<string>;
  readLifecycleSubscription(id: string): Promise<TeamLifecycleReadResult>;
  closeLifecycleSubscription(id: string): Promise<void>;
}
