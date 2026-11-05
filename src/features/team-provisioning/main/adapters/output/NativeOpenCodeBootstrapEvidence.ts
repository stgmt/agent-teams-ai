import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapEvidencePorts,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeBootstrapEvidence';

/**
 * What the app can still prove about a member's bootstrap session.
 *
 * Two separate questions, both answered from disk evidence rather than from
 * memory: whether this run is the one the lane is on, and whether that run
 * committed a bootstrap session for this member. The watchdog uses them to tell
 * a prompt that can still be delivered from one whose lane is gone — wrong here
 * and it either replays a prompt into a dead session or abandons a live one.
 */
export interface NativeOpenCodeBootstrapEvidenceDependencies {
  teamsBasePath: string;
  /** The run the runtime is on for this lane; memory first, disk evidence otherwise. */
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  warn(message: string): void;
}

export interface NativeOpenCodeBootstrapEvidence {
  /**
   * The tracked run id, but only while it is the one this lane is actually on.
   */
  resolveTrackedBootstrapRunId(input: {
    teamName: string;
    laneId: string;
    runId: string;
  }): Promise<string | null>;
  /** A committed bootstrap session this delivery may rely on. */
  hasCommittedBootstrapSession(input: {
    teamName: string;
    laneId: string;
    runId: string;
    memberName: string;
  }): Promise<boolean>;
  /** Records a verified bootstrap session; the runtime's check-in lands here. */
  commitBootstrapSession(input: {
    teamName: string;
    laneId: string;
    runId: string;
    memberName: string;
    runtimeSessionId: string;
    observedAt: string;
  }): Promise<void>;
}

export function createNativeOpenCodeBootstrapEvidence(
  deps: NativeOpenCodeBootstrapEvidenceDependencies
): NativeOpenCodeBootstrapEvidence {
  const ports: OpenCodeRuntimeBootstrapEvidencePorts =
    createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
      teamsBasePath: deps.teamsBasePath,
      warn: deps.warn,
    });

  return {
    resolveTrackedBootstrapRunId: async ({ teamName, laneId, runId }) => {
      const current = await deps.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId);
      return current === runId ? runId : null;
    },
    hasCommittedBootstrapSession: async (input) =>
      Boolean(await findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(input, ports)),
    commitBootstrapSession: async (input) => {
      await commitOpenCodeRuntimeBootstrapSessionEvidence(input, ports);
    },
  };
}
