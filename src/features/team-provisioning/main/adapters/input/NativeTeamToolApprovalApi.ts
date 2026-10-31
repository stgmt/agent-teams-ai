import type { TeamRunRegistryRead } from '../../../contracts';
import type { MemberLifecycleCommands } from '../../../core/application/commands/MemberLifecycleCommands';
import type { NativeClaudeToolApprovals } from '../output/NativeClaudeToolApprovals';
import type { NativeToolApprovalSettings } from '../output/NativeToolApprovalSettings';
import type { TeamToolApprovalApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { ToolApprovalSettings } from '@shared/types';

interface Dependencies {
  runs: Pick<TeamRunRegistryRead, 'find'>;
  commands: Pick<MemberLifecycleCommands, 'answerLanePermission'>;
  claudeApprovals?: Pick<NativeClaudeToolApprovals, 'respond'>;
  settings?: Pick<NativeToolApprovalSettings, 'update'>;
}

/**
 * Tool approvals for adapter lanes and Claude processes. Settings are native but
 * in-memory; persistence is a separate concern.
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

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    if (!this.deps.settings) throw new Error('Tool approval settings are not migrated');
    this.deps.settings.update(teamName, settings);
  }
}
