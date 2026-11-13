import { OpenCodeRuntimeApprovalProvider } from '@main/services/team/approvals/OpenCodeRuntimeApprovalProvider';
import {
  type RuntimeToolApprovalClearOptions,
  RuntimeToolApprovalCoordinator,
  type RuntimeToolApprovalEvent,
  type RuntimeToolApprovalSyncScope,
} from '@main/services/team/approvals/RuntimeToolApprovalCoordinator';

import type { TeamRunRegistryRead } from '../../contracts';
import type {
  NativeClaudeApproval,
  NativeClaudeToolApprovals,
} from '../adapters/output/NativeClaudeToolApprovals';
import type { RuntimeToolApprovalEntry } from '@main/services/team/approvals/RuntimeToolApprovalCoordinator';
import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';

type OpenCodeApprovalState = Parameters<
  OpenCodeRuntimeApprovalProvider['collectPendingApprovals']
>[0];

/**
 * Collects the approvals an OpenCode lane is waiting on. Defaults to the provider
 * that reads the runtime's own state; a caller supplies its own only when it already
 * holds that state, and never to bypass the provider's filtering.
 */
export interface NativeOpenCodeApprovalSource {
  collect(input: OpenCodeApprovalState): readonly RuntimeToolApprovalEntry[];
}

/**
 * What the approval surface needs from the shell.
 *
 * OpenCode requests belong to the coordinator; Claude requests stay in the
 * lifecycle's own approval store. Both leave through `emitApprovalEvent`, without
 * copying pending requests into a second store.
 */
export interface NativeRuntimeToolApprovalSources {
  claude: {
    approvals: Pick<NativeClaudeToolApprovals, 'onEvent' | 'list'>;
    runs: Pick<TeamRunRegistryRead, 'find' | 'findByRunId' | 'aliveTeamNames'>;
  };
  getSettings(teamName: string): ToolApprovalSettings;
  /**
   * Sends the answer back to the bridge that asked. The shell supplies this because
   * answering needs the lane's launch state and expected members, which the approval
   * entry does not carry; building them here would mean holding launch state twice.
   */
  answerOpenCodePermission(input: {
    teamName: string;
    runId: string;
    laneId?: string;
    memberName: string;
    requestId: string;
    decision: 'allow' | 'reject';
    message?: string;
  }): Promise<void>;
  emitApprovalEvent(event: RuntimeToolApprovalEvent): void;
  showApprovalNotification?(approval: ToolApprovalRequest): void;
  dismissApprovalNotification?(requestId: string): void;
  logWarning?(message: string): void;
  approvals?: NativeOpenCodeApprovalSource;
}

/**
 * The state the collector needs beyond the sync scope: where the lane runs, who
 * is on it, and which members the team expects. Kept together because a collector
 * that saw one without the others would report approvals for a stale roster.
 */
export type NativeOpenCodeApprovalSyncInput = RuntimeToolApprovalSyncScope & OpenCodeApprovalState;

export interface NativeRuntimeToolApproval {
  /**
   * The user's answer for one pending approval. Routing lives here because the
   * coordinator stores entries but does not know which bridge must receive the
   * answer; leaving it out would make an answered approval look answered while
   * the runtime still waits.
   */
  respond(input: {
    teamName: string;
    runId: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }): Promise<boolean>;
  /** Records the approvals an OpenCode lane is waiting on, replacing the lane's set. */
  syncOpenCodeRuntimeToolApprovals(input: NativeOpenCodeApprovalSyncInput): void;
  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options?: Omit<RuntimeToolApprovalClearOptions, 'providerId'>
  ): void;
  /** Re-publishes unresolved native requests after the renderer becomes available. */
  replayPendingClaudeApprovals(): void;
  /** Owns OpenCode pending requests; Claude requests remain lifecycle-owned. */
  coordinator: RuntimeToolApprovalCoordinator;
}

/**
 * The approval coordinator the native root owns.
 *
 * Answers are routed by the entry's provider rather than by the caller: an
 * OpenCode entry goes back to the OpenCode adapter's permission bridge, which is
 * the only place that knows the lane's runtime session. Sending it anywhere else
 * would answer an approval the runtime never receives.
 */
export function createNativeRuntimeToolApproval(
  sources: NativeRuntimeToolApprovalSources
): NativeRuntimeToolApproval {
  const openCode = new OpenCodeRuntimeApprovalProvider();
  const collect = sources.approvals
    ? (input: OpenCodeApprovalState) => sources.approvals!.collect(input)
    : (input: OpenCodeApprovalState) => openCode.collectPendingApprovals(input);
  const answerEntry = async (entry: RuntimeToolApprovalEntry, allow: boolean, message?: string) => {
    if (entry.providerId !== 'opencode') return;
    await sources.answerOpenCodePermission({
      teamName: entry.approval.teamName,
      runId: entry.approval.runId,
      ...(entry.laneId ? { laneId: entry.laneId } : {}),
      memberName: entry.memberName,
      requestId: entry.providerRequestId,
      decision: allow ? 'allow' : 'reject',
      ...(message ? { message } : {}),
    });
  };
  const coordinator = new RuntimeToolApprovalCoordinator({
    getSettings: (teamName) => sources.getSettings(teamName),
    answerApproval: ({ entry, allow, message }) => answerEntry(entry, allow, message),
    emitApprovalEvent: (event) => sources.emitApprovalEvent(event),
    ...(sources.showApprovalNotification
      ? { showApprovalNotification: sources.showApprovalNotification }
      : {}),
    ...(sources.dismissApprovalNotification
      ? { dismissApprovalNotification: sources.dismissApprovalNotification }
      : {}),
    ...(sources.logWarning ? { logWarning: sources.logWarning } : {}),
  });
  const emitClaudeRequest = (approval: NativeClaudeApproval): void => {
    sources.emitApprovalEvent({
      requestId: approval.requestId,
      runId: approval.run.runId,
      teamName: approval.run.teamName,
      source: approval.token.memberName,
      toolName: approval.toolName,
      toolInput: approval.toolInput,
      receivedAt: approval.receivedAt,
    });
  };
  sources.claude.approvals.onEvent((event) => {
    if (event.type === 'requested') {
      emitClaudeRequest(event.approval);
    } else if (event.type === 'resolved') {
      const run = sources.claude.runs.findByRunId(event.runId);
      if (run)
        sources.emitApprovalEvent({
          autoResolved: true,
          requestId: event.requestId,
          runId: event.runId,
          teamName: run.identity.teamName,
          reason: 'runtime_resolved',
          allowed: event.allow,
        });
    } else if (event.type === 'dismissed') {
      sources.emitApprovalEvent({
        dismissed: true,
        teamName: event.teamName,
        runId: event.runId,
      });
    } else {
      sources.logWarning?.(`Native approval failed for ${event.runId}: ${event.message}`);
    }
  });
  const replayPendingClaudeApprovals = (): void => {
    for (const teamName of sources.claude.runs.aliveTeamNames()) {
      const run = sources.claude.runs.find(teamName);
      if (!run) continue;
      for (const approval of sources.claude.approvals.list(run.identity.runId)) {
        emitClaudeRequest(approval);
      }
    }
  };
  replayPendingClaudeApprovals();

  return {
    coordinator,
    replayPendingClaudeApprovals,
    // The coordinator owns the pending set, the runId guard and the timeout, so the
    // answer goes through it rather than being routed around it.
    respond: ({ teamName, runId, requestId, allow, message }) =>
      coordinator.respond(teamName, runId, requestId, allow, message),
    syncOpenCodeRuntimeToolApprovals: (input) => {
      coordinator.sync(input, [...collect(input)]);
    },
    clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
      coordinator.clear(teamName, { ...options, providerId: 'opencode' }),
  };
}
