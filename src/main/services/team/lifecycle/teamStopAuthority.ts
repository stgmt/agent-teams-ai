import { TeamLaunchStateStore } from '../TeamLaunchStateStore';

import type { TeamLaunchStopAuthority } from '../TeamLaunchStateStore';
import type { TeamForceStopResult } from '@shared/types';

export function incompleteStopResult(
  stopOutcome: TeamForceStopResult['stopOutcome'],
  diagnostics: string[],
  clearedPendingDeliveries: number,
  causalFailure?: TeamForceStopResult['causalFailure']
): TeamForceStopResult {
  return {
    stopOutcome,
    ...(causalFailure ? { causalFailure } : {}),
    cleanupOutcome: 'incomplete',
    killedRuntimePids: [],
    clearedPendingDeliveries,
    diagnostics,
  };
}

interface StopAuthorityPorts {
  getStopTargetRunId?(teamName: string): string | null;
  markTeamStopped?: (
    teamName: string,
    authority: TeamLaunchStopAuthority
  ) => Promise<boolean | void>;
  logWarning(message: string): void;
}

/** Fences all extra cleanup to the publication admitted for this Stop. */
export class TeamStopAuthority {
  failed = false;
  authority: TeamLaunchStopAuthority | undefined;

  private constructor(
    private readonly teamName: string,
    private readonly ports: StopAuthorityPorts,
    private readonly diagnostics: string[],
    readonly expectedRunId: string | null | undefined
  ) {}

  static async admit(
    teamName: string,
    ports: StopAuthorityPorts,
    diagnostics: string[]
  ): Promise<{ guard: TeamStopAuthority } | { error: string }> {
    let expectedRunId: string | null | undefined;
    if (ports.getStopTargetRunId) {
      try {
        const captured = ports.getStopTargetRunId(teamName);
        if (
          captured !== null &&
          (typeof captured !== 'string' || !captured.trim() || captured !== captured.trim())
        )
          throw new Error('Invalid stop target identity');
        expectedRunId = captured;
      } catch (error) {
        const message = `Stop target could not be identified: ${String(error)}`;
        ports.logWarning(`[${teamName}] ${message}`);
        return { error: message };
      }
    }
    const guard = new TeamStopAuthority(teamName, ports, diagnostics, expectedRunId);
    if (ports.markTeamStopped) {
      try {
        guard.authority = await new TeamLaunchStateStore().beginStop(teamName, expectedRunId);
      } catch (error) {
        guard.failed = true;
        ports.logWarning(`[${teamName}] Stopped-state admission failed: ${String(error)}`);
        diagnostics.push(`Stopped-state admission failed: ${String(error)}`);
      }
    }
    return { guard };
  }

  async run(operation: () => Promise<void>): Promise<void> {
    if (this.failed) return;
    if (!this.ports.markTeamStopped) {
      await operation();
      return;
    }
    if (!this.authority) {
      this.failed = true;
      return;
    }
    try {
      const result = await new TeamLaunchStateStore().withStopAuthority(
        this.teamName,
        this.authority,
        operation
      );
      if (!result.current) {
        this.failed = true;
        this.diagnostics.push('Stop cleanup authority was superseded by a newer run');
      }
    } catch (error) {
      this.failed = true;
      const message = `Stop cleanup authority could not be checked: ${String(error)}`;
      this.ports.logWarning(`[${this.teamName}] ${message}`);
      this.diagnostics.push(message);
    }
  }
}
