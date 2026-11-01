import type { TeamRunIdentity, TeamRunRegistryRead } from '../../../contracts';
import type { MemberLifecycleCommands } from '../../../core/application/commands/MemberLifecycleCommands';
import type { NativeLeadRestartAvailability } from './NativeLeadRestartAssessment';
import type { NativeLeadRestartAssessment } from './NativeLeadRestartAssessment';
import type { NativeLeadRuntimeSettings } from './NativeLeadRestartAssessment';
import type { NativeLeadOutputStream } from './NativeLeadOutputStream';

export interface NativeLeadRuntimeRestartDependencies {
  /** Restart admission: run liveness, turn activity, approvals, detected session. */
  assessment: Pick<NativeLeadRestartAssessment, 'assess'>;
  /** The single process owner: stopping and re-spawning the lead happens there. */
  lifecycle: Pick<MemberLifecycleCommands, 'restartLeadWithSettings' | 'cancelPendingLaunches'>;
  runs: Pick<TeamRunRegistryRead, 'find'>;
  leadOutput: Pick<NativeLeadOutputStream, 'detectedSessionId'>;
}

export interface NativeLeadRuntimeRestartInput {
  teamName: string;
  expectedRunId: string;
  before: Readonly<NativeLeadRuntimeSettings>;
  after: Readonly<NativeLeadRuntimeSettings>;
}

/**
 * Lead-only runtime restart over native ownership.
 *
 * The decisions are the ones the assessment already makes; this class only
 * carries them out. The run id is fenced twice - once by the assessment, once by
 * the lifecycle command that stops the process - so a caller that lost the run
 * cannot replace a process it no longer owns, and the previous process is never
 * killed before the replacement is admitted.
 */
export class NativeLeadRuntimeRestart {
  constructor(private readonly deps: NativeLeadRuntimeRestartDependencies) {}

  assess(
    teamName: string,
    settings: Readonly<NativeLeadRuntimeSettings>
  ): Promise<NativeLeadRestartAvailability> {
    return this.deps.assessment.assess(teamName, settings);
  }

  async restart(input: Readonly<NativeLeadRuntimeRestartInput>): Promise<void> {
    const admission = await this.deps.assessment.assess(input.teamName, input.after);
    if (admission.outcome !== 'ready' || admission.runId !== input.expectedRunId) {
      throw new Error(
        admission.outcome === 'ready' ? 'Lead run owner changed' : admission.reason
      );
    }
    const snapshot = this.deps.runs.find(input.teamName);
    if (!snapshot) throw new Error('Lead run is no longer registered');
    const lead = Object.values(snapshot.members).find(
      (member) => member.role === 'lead' && member.membership === 'configured'
    );
    if (!lead) throw new Error('Lead member is not configured');
    const sessionId = this.deps.leadOutput.detectedSessionId(input.expectedRunId);
    if (!sessionId) throw new Error('Lead resume ownership is unproven');
    const team: Readonly<TeamRunIdentity> = snapshot.identity;
    await this.deps.lifecycle.restartLeadWithSettings({
      team,
      memberName: lead.memberName,
      generation: lead.generation,
      expectedRunId: input.expectedRunId,
      overrides: {
        model: input.after.model,
        effort: input.after.effort ?? undefined,
        resumeSessionId: sessionId,
      },
    });
  }

  cancelPendingLaunches(): Promise<void> {
    return this.deps.lifecycle.cancelPendingLaunches();
  }
}
