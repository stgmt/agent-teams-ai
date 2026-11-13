import { randomBytes, randomUUID } from 'node:crypto';

import { MemberLifecycleCommands } from '../../core/application/commands/MemberLifecycleCommands';
import { StartBoundMember } from '../../core/application/commands/StartBoundMember';
import { TeamLifecycleCommands } from '../../core/application/commands/TeamLifecycleCommands';
import { LeadMemberStartAuthority } from '../../core/application/LeadMemberStartAuthority';
import { MemberLifecycleRegistry } from '../../core/domain/MemberLifecycleRegistry';

import {
  NativeTeamOperationActivity,
  ObservedTeamOperationQueue,
} from './NativeTeamOperationActivity';

import type {
  ConfiguredMemberIdentity,
  MemberProcessToken,
  TeamLaneGroup,
  TeamLifecycleFeed,
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaunchSettingsPort,
  MemberRuntimePort,
  TeamRunResourcesPort,
} from '../../core/application/ports/MemberRuntimePorts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export interface MemberLifecycleDependencies {
  owner: AppConnectionContext;
  /**
   * The composition root's single registry instance. Supplying it lets the root
   * hold the same owner the lifecycle mutates instead of creating a second one.
   */
  registry?: MemberLifecycleRegistry;
  settings: MemberLaunchSettingsPort;
  runtime: MemberRuntimePort;
  authority?: LeadMemberStartAuthority;
  teamResources?: TeamRunResourcesPort;
  laneGroups?(
    run: Readonly<TeamRunIdentity>,
    members: readonly ConfiguredMemberIdentity[]
  ): readonly TeamLaneGroup[] | Promise<readonly TeamLaneGroup[]>;
  registerConfiguredMember?(
    team: TeamRunIdentity,
    launch: Readonly<ConfiguredMemberLaunch>
  ): Promise<void>;
  onMemberConnected?(
    launch: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>
  ): Promise<void>;
  /** A member runtime failed; the recovery feature decides what to do with it. */
  reportRuntimeFailure?(input: {
    teamName: string;
    memberName: string;
    runId: string;
    detail: string;
  }): void;
}

export interface MemberLifecycle {
  registry: MemberLifecycleRegistry;
  activity: NativeTeamOperationActivity;
  commands: MemberLifecycleCommands;
  teams: TeamLifecycleCommands;
  leadStart: StartBoundMember;
  bindLead(run: TeamRunIdentity): string;
  revokeLead(run: TeamRunIdentity): void;
  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot>;
  watch(teamName: string): TeamLifecycleFeed;
}

export function createMemberLifecycle(dependencies: MemberLifecycleDependencies): MemberLifecycle {
  const registry = dependencies.registry ?? new MemberLifecycleRegistry(dependencies.owner);
  const authority = dependencies.authority ?? new LeadMemberStartAuthority();
  const activity = new NativeTeamOperationActivity();
  const gate = new ObservedTeamOperationQueue(activity);
  const commands = new MemberLifecycleCommands({
    registry,
    gate,
    settings: dependencies.settings,
    runtime: dependencies.runtime,
    nextOperationId: randomUUID,
    ...(dependencies.registerConfiguredMember
      ? { registerConfiguredMember: dependencies.registerConfiguredMember }
      : {}),
    ...(dependencies.onMemberConnected
      ? { onMemberConnected: dependencies.onMemberConnected }
      : {}),
    ...(dependencies.reportRuntimeFailure
      ? { reportRuntimeFailure: dependencies.reportRuntimeFailure }
      : {}),
  });
  return {
    registry,
    activity,
    commands,
    teams: new TeamLifecycleCommands({
      registry,
      members: commands,
      authority,
      gate,
      resources: dependencies.teamResources,
      ...(dependencies.laneGroups ? { laneGroups: dependencies.laneGroups } : {}),
      nextOperationId: randomUUID,
      nextRunId: randomUUID,
      nextCredential: () => randomBytes(32).toString('base64url'),
    }),
    leadStart: new StartBoundMember(authority, commands),
    bindLead(run: TeamRunIdentity): string {
      const credential = randomBytes(32).toString('base64url');
      authority.bind(credential, run);
      return credential;
    },
    revokeLead: (run: TeamRunIdentity) => authority.revokeRun(run),
    snapshot: (teamName: string) => registry.snapshot(teamName),
    watch: (teamName: string) => registry.watch(teamName),
  };
}
