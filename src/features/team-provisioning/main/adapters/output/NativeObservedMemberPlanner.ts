import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemberProcessToken } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeClaudeSdkOutputEvidence } from './NativeClaudeSdkHost';
import type { NativeClaudeToolApprovals } from './NativeClaudeToolApprovals';
import type { NativeLeadOutputStream } from './NativeLeadOutputStream';
import type { NativeTeamLogStore } from './NativeTeamLogStore';
import type { NodeMemberConnectionPlan, NodeMemberLaunchPlanner } from './NodeMemberRuntime';

export interface NativeObservedMemberPlannerPorts {
  approvals: Pick<NativeClaudeToolApprovals, 'observeLine'>;
  leadOutput: Pick<NativeLeadOutputStream, 'observeLine'>;
  logs: Pick<NativeTeamLogStore, 'append'>;
}

/**
 * One observation seam for every owned member process: approval control
 * requests, app-owned lead output, and the in-memory log all read the same
 * stdout lines, so the launch planner must never choose between them.
 */
export function createObservedMemberPlanner(
  planner: NodeMemberLaunchPlanner,
  ports: NativeObservedMemberPlannerPorts
): NodeMemberLaunchPlanner {
  const decorate = <T extends NodeMemberConnectionPlan>(
    plan: T,
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>
  ): T => ({
    ...plan,
    observeOutput: (
      line: string,
      stream: 'stdout' | 'stderr',
      evidence?: NativeClaudeSdkOutputEvidence
    ) => {
      if (stream === 'stdout') {
        ports.approvals.observeLine(token, line, evidence);
        ports.leadOutput.observeLine(
          { token, memberName: settings.memberName, role: settings.role },
          line
        );
      }
      ports.logs.append(
        token.runId,
        token.teamName,
        stream === 'stderr' ? `[stderr] ${line}` : line
      );
      if (process.env.AGTS_CAPTURE_MEMBER_OUTPUT === '1') {
        try {
          appendFileSync(
            join(tmpdir(), 'agts-member-output.txt'),
            `${new Date().toISOString()} ${settings.memberName} ${stream} ${line}\n`
          );
        } catch {
          // diagnostics only
        }
      }
      return plan.observeOutput?.(line, stream, evidence) ?? null;
    },
  });
  return {
    ...(planner.observeOutput ? { observeOutput: planner.observeOutput } : {}),
    async prepare(settings, token, signal) {
      return decorate(await planner.prepare(settings, token, signal), settings, token);
    },
    async recover(settings, token, signal, identity) {
      return decorate(await planner.recover(settings, token, signal, identity), settings, token);
    },
  };
}
