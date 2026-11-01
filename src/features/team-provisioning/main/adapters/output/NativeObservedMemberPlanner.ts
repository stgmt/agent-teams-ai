import type { NativeClaudeToolApprovals } from './NativeClaudeToolApprovals';
import type { NativeLeadOutputStream } from './NativeLeadOutputStream';
import type { NativeTeamLogStore } from './NativeTeamLogStore';
import type { NodeMemberLaunchPlan, NodeMemberLaunchPlanner } from './NodeMemberRuntime';

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
  return {
    ...(planner.observeOutput ? { observeOutput: planner.observeOutput } : {}),
    async prepare(settings, token, signal): Promise<NodeMemberLaunchPlan> {
      const plan = await planner.prepare(settings, token, signal);
      return {
        ...plan,
        observeOutput: (line: string, stream: 'stdout' | 'stderr') => {
          if (stream === 'stdout') {
            ports.approvals.observeLine(token, line);
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
          return plan.observeOutput?.(line, stream) ?? null;
        },
      };
    },
  };
}
