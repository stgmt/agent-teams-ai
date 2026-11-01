import type { TeamRunRegistryRead } from '../../../contracts';

export interface NativeMcpConsumerQueryDependencies {
  runs: Pick<TeamRunRegistryRead, 'aliveTeamNames' | 'find'>;
  /**
   * Providers each member was configured with for that run, captured at launch.
   * Absent before the launch has read its settings.
   */
  configuredProviders?(runId: string): ReadonlyMap<string, string> | null;
  /**
   * Launches admitted but not yet visible as a run. A launch in flight may still
   * resolve to OpenCode, so the bridge must survive it exactly as it survives a
   * run in `preparing`.
   */
  pendingLaunchAdmissions?(): number;
}

/**
 * Answers whether the app-owned HTTP MCP bridge must stay up.
 *
 * The legacy predicate read the run payload (`request.providerId`,
 * `allEffectiveMembers`, `mixedSecondaryLanes`), which the native registry does
 * not hold. It is reproduced from the facts the native owner actually has:
 *
 * - the providers a member was *configured* with, captured when the launch read
 *   its canonical settings - the same field legacy read as
 *   `request.providerId` / `allEffectiveMembers[].providerId`. It is the only
 *   source that still answers after a lane went away;
 * - a lane-backed member (`member.lane !== null`), because only
 *   `NativeOpenCodeLaneRuntime` produces lane observations;
 * - a run in `preparing`/`starting`, and a member still `starting`/`connecting`,
 *   which the legacy predicate over-approximated the same way for a pending
 *   admission: the provider may still resolve to OpenCode.
 */
export class NativeMcpConsumerQuery {
  constructor(private readonly deps: NativeMcpConsumerQueryDependencies) {}

  hasLiveOpenCodeMcpConsumers(): boolean {
    if ((this.deps.pendingLaunchAdmissions?.() ?? 0) > 0) return true;
    for (const teamName of this.deps.runs.aliveTeamNames()) {
      const snapshot = this.deps.runs.find(teamName);
      if (!snapshot) continue;
      if (snapshot.state === 'preparing' || snapshot.state === 'starting') return true;
      const configured = this.deps.configuredProviders?.(snapshot.identity.runId) ?? null;
      for (const [memberName, member] of Object.entries(snapshot.members)) {
        if (configured?.get(memberName) === 'opencode') return true;
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
