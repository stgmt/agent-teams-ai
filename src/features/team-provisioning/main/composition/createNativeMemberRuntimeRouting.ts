import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';

import { NativeOpenCodeLaneRuntime } from '../adapters/output/NativeOpenCodeLaneRuntime';

import type { ConfiguredMemberIdentity, TeamLaneGroup, TeamRunIdentity } from '../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaunchSettingsPort,
  MemberRuntimePort,
} from '../../core/application/ports/MemberRuntimePorts';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

export interface NativeMemberRuntimeRoutingDependencies {
  processRuntime: MemberRuntimePort;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  openCodeAdapter?: Pick<
    TeamLaunchRuntimeAdapter,
    'launch' | 'reconcile' | 'stop' | 'answerRuntimePermission' | 'listRuntimePermissions'
  >;
}

export interface NativeMemberRuntimeRouting {
  runtime: MemberRuntimePort;
  laneGroups(
    run: Readonly<TeamRunIdentity>,
    members: readonly ConfiguredMemberIdentity[]
  ): Promise<readonly TeamLaneGroup[]>;
}

/**
 * Routes OpenCode to adapter lanes and every other provider to owned member
 * processes. A pure OpenCode roster shares one primary lane; mixed rosters give
 * each OpenCode member its own secondary lane.
 */
export function createNativeMemberRuntimeRouting(
  deps: NativeMemberRuntimeRoutingDependencies
): NativeMemberRuntimeRouting {
  const lane = deps.openCodeAdapter
    ? new NativeOpenCodeLaneRuntime({ adapter: deps.openCodeAdapter })
    : null;
  const runtime: MemberRuntimePort = {
    kind: (providerId) => (lane && providerId === 'opencode' ? 'lane' : 'process'),
    spawn: (settings: Readonly<ConfiguredMemberLaunch>, token, signal) =>
      deps.processRuntime.spawn(settings, token, signal),
    ...(lane
      ? {
          startLane: (settings: Readonly<ConfiguredMemberLaunch>, token, signal) =>
            lane.startLane(settings, token, signal),
          startLaneGroup: (
            settings: readonly Readonly<ConfiguredMemberLaunch>[],
            tokens: Parameters<NonNullable<MemberRuntimePort['startLaneGroup']>>[1],
            laneId: string,
            signal: AbortSignal
          ) => lane.startLaneGroup(settings, tokens, laneId, signal),
        }
      : {}),
  };

  const laneGroups = async (
    run: Readonly<TeamRunIdentity>,
    members: readonly ConfiguredMemberIdentity[]
  ): Promise<readonly TeamLaneGroup[]> => {
    if (!lane) return [];
    const providers = await Promise.all(
      members.map(async (member) => {
        const launch = await deps.settings.findConfiguredMember(run, member.memberName);
        return { memberName: member.memberName, providerId: launch?.providerId };
      })
    );
    const openCode = providers
      .filter((member) => member.providerId === 'opencode')
      .map((member) => member.memberName);
    if (openCode.length === 0) return [];
    if (openCode.length === providers.length) return [{ laneId: 'primary', memberNames: openCode }];
    return openCode.map((memberName) => ({
      laneId: buildOpenCodeSecondaryLaneId({ name: memberName }),
      memberNames: [memberName],
    }));
  };

  return { runtime, laneGroups };
}
