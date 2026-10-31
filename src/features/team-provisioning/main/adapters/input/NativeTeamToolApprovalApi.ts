import type { TeamRunRegistryRead } from '../../../contracts';
import type { MemberLifecycleCommands } from '../../../core/application/commands/MemberLifecycleCommands';
import type { NativeClaudeToolApprovals } from '../output/NativeClaudeToolApprovals';
import type { TeamToolApprovalApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { ToolApprovalSettings } from '@shared/types';

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find'>;
  commands: Pick<MemberLifecycleCommands, 'answerLanePermission'>;
  claudeApprovals?: Pick<NativeClaudeToolApprovals, 'respond'>;
}

/**
 * Tool approvals for adapter lanes. Claude process approvals still depend on the
 * legacy control path and are not migrated; settings writes fail closed too.
 */
export class NativeTeamToolApprovalApi implements TeamToolApprovalApi {
  constructor(private readonly deps: Dependencies) {}

  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot || snapshot.identity.runId !== runId) throw new Error('Unknown runId');
    try {
      await this.deps.commands.answerLanePermission({
        run: snapshot.identity,
        requestId,
        allow,
        ...(message ? { message } : {}),
      });
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Unknown permission request') throw error;
    }
    if (
      this.deps.claudeApprovals &&
      (await this.deps.claudeApprovals.respond(runId, requestId, allow, message))
    )
      return;
    throw new Error('Unknown permission request');
  }

  updateToolApprovalSettings(_teamName: string, _settings: ToolApprovalSettings): void {
    throw new Error('Tool approval settings are not migrated');
  }
}
