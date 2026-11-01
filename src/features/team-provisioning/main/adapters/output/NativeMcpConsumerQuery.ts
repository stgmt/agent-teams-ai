import type { TeamRunRegistryRead } from '../../../contracts';

export interface NativeMcpConsumerQueryDependencies {
  runs: Pick<TeamRunRegistryRead, 'aliveTeamNames' | 'find'>;
}

/**
 * Answers whether the app-owned HTTP MCP bridge must stay up.
 *
 * The legacy predicate read the run payload (`request.providerId`,
 * `allEffectiveMembers`, `mixedSecondaryLanes`), which the native registry does
 * not hold. The registry does carry the two facts that matter:
 *
 * - an OpenCode member is lane-backed, so `member.lane !== null` marks exactly
 *   the members that consume the bridge (only `NativeOpenCodeLaneRuntime`
 *   produces lane observations);
 * - a run in `preparing`/`starting` may still resolve to OpenCode, and the
 *   legacy predicate over-approximated the same way by returning true for any
 *   pending admission.
 */
export class NativeMcpConsumerQuery {
  constructor(private readonly deps: NativeMcpConsumerQueryDependencies) {}

  hasLiveOpenCodeMcpConsumers(): boolean {
    for (const teamName of this.deps.runs.aliveTeamNames()) {
      const snapshot = this.deps.runs.find(teamName);
      if (!snapshot) continue;
      if (snapshot.state === 'preparing' || snapshot.state === 'starting') return true;
      if (Object.values(snapshot.members).some((member) => member.lane !== null)) return true;
    }
    return false;
  }
}
