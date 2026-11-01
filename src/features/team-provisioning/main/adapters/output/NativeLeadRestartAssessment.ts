import type { TeamRunIdentity, TeamRunRegistryRead } from '../../../contracts';
import type { MemberLaunchSettingsPort } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeClaudeToolApprovals } from './NativeClaudeToolApprovals';
import type { NativeLeadOutputStream } from './NativeLeadOutputStream';

export type NativeLeadProviderId = 'anthropic' | 'codex' | 'gemini';

export interface NativeLeadRuntimeSettings {
  providerId: NativeLeadProviderId;
  model: string | null;
  effort: string | null;
}

export type NativeLeadRestartAvailability =
  | { outcome: 'ready'; runId: string }
  | { outcome: 'busy'; reason: string }
  | { outcome: 'relaunch_required'; reason: string };

interface NativeLeadRestartAssessmentDependencies {
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  settings: Pick<MemberLaunchSettingsPort, 'findConfiguredMember'>;
  leadOutput: Pick<NativeLeadOutputStream, 'facts' | 'detectedSessionId'>;
  approvals: Pick<NativeClaudeToolApprovals, 'list'>;
}

const RESUMABLE_PROVIDERS: Record<NativeLeadProviderId, true> = {
  anthropic: true,
  codex: true,
  gemini: true,
};

/**
 * Lead-only runtime restart admission over native facts.
 *
 * The decision is identical to the legacy assessment (same order, same
 * reasons), but every input comes from the native owner: run liveness from the
 * registry, turn activity and the detected session from the lead output
 * capture, and pending approvals from the approval store. Turn activity is the
 * reason this could not exist before the capture: without it a "ready" verdict
 * would resume the lead in the middle of a running turn.
 *
 * `authRetryInProgress` has no native source yet; it is treated as `false`
 * until the native runtime exposes that state.
 */
export class NativeLeadRestartAssessment {
  constructor(private readonly deps: NativeLeadRestartAssessmentDependencies) {}

  async assess(
    teamName: string,
    settings: Readonly<NativeLeadRuntimeSettings>
  ): Promise<NativeLeadRestartAvailability> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot || !this.deps.runs.isLive(snapshot.identity))
      return { outcome: 'relaunch_required', reason: 'No exact app-owned live lead run' };

    const lead = Object.values(snapshot.members).find((member) => member.role === 'lead');
    if (!lead) return { outcome: 'relaunch_required', reason: 'No exact app-owned live lead run' };

    if (!RESUMABLE_PROVIDERS[settings.providerId])
      return { outcome: 'relaunch_required', reason: 'Provider does not support lead-only resume' };

    const configured = await this.deps.settings.findConfiguredMember(
      snapshot.identity,
      lead.memberName
    );
    if (!configured)
      return { outcome: 'relaunch_required', reason: 'Lead provider ownership changed' };
    if (configured.providerId !== settings.providerId)
      return { outcome: 'relaunch_required', reason: 'Lead provider ownership changed' };

    const identity: Readonly<TeamRunIdentity> = snapshot.identity;
    const facts = this.deps.leadOutput.facts(identity.runId);
    const pendingApprovals = this.deps.approvals.list(identity.runId).length;
    if (facts?.activity !== 'idle' || (facts?.activeToolCalls.length ?? 0) > 0 || pendingApprovals > 0)
      return { outcome: 'busy', reason: 'Lead has an active turn, tool call, or approval' };

    if (!this.deps.leadOutput.detectedSessionId(identity.runId))
      return { outcome: 'relaunch_required', reason: 'Lead resume ownership is unproven' };

    return { outcome: 'ready', runId: identity.runId };
  }
}
