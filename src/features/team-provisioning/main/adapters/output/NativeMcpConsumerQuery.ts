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
 *   pending admission;
 * - a member still `starting`/`connecting` has no lane observation yet, so its
 *   provider is still unknown and the bridge must stay up until it is known.
 */
export class NativeMcpConsumerQuery {
  constructor(private readonly deps: NativeMcpConsumerQueryDependencies) {}

  hasLiveOpenCodeMcpConsumers(): boolean {
    for (const teamName of this.deps.runs.aliveTeamNames()) {
      const snapshot = this.deps.runs.find(teamName);
      if (!snapshot) continue;
      if (snapshot.state === 'preparing' || snapshot.state === 'starting') return true;
      for (const member of Object.values(snapshot.members)) {
        if (member.lane !== null) return true;
        // A member that has not been observed yet may still turn out to be
        // lane-backed; tearing the bridge down before that answer exists would
        // strand an OpenCode host that is already starting.
        if (member.phase === 'starting' || member.phase === 'connecting') return true;
      }
    }
    return false;
  }
}
