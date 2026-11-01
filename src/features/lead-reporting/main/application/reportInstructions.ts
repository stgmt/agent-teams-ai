import type { LeadReportRun } from '../../contracts';

/** Shared by request admission and the existing launch/context adapters. */
export function buildEvidenceBasedLeadReplyInstruction(): string {
  return 'For an actual human question about the team, use lead_briefing and read unclear task/comment/result details before answering. Cover the complete saved roster unless the human explicitly named a narrower scope, including stopped members and members without tasks. Explain actual work, last result and its age, blockers, actions you actually took, and the next step. Distinguish a member claim from independently checked evidence; process readiness and historical launch confirmation are not work progress. Preserve the original request identity and action mode; a read-only question does not authorize restarts or reassignment. If a source cannot be read, state that concrete limitation rather than inventing progress.';
}

export function buildLeadServiceRefreshInstruction(): string {
  return 'Application-generated context refresh, not a new human request. Preserve the original request identity and action mode. Continue the pending human request under its original instructions; do not replace it with a generic readiness acknowledgement. When no human request is pending, restore standing context without manufacturing a status request.';
}

interface LeadContextRefresh {
  type: 'user';
  isMeta: true;
  origin: { kind: 'coordinator' };
  message: { role: 'user'; content: { type: 'text'; text: string }[] };
}

export function buildLeadReportRequestInstruction(report: LeadReportRun): string {
  return [
    `Human report request: ${report.requestMessageId}. Report operation: ${report.reportRunId}.`,
    report.scope.kind === 'team'
      ? 'Scope: the entire saved roster excluding the lead, including stopped members and members without tasks.'
      : `Scope: only ${report.scope.memberNames.join(', ')}. Do not present this as a whole-team report.`,
    buildEvidenceBasedLeadReplyInstruction(),
    'Publish through message_send to user with report: inspectionId, summary, members with evidence-linked statements, and nextStep; text equals summary.',
    'Every scoped member needs coverage. Do not send a generic readiness line or promote an acknowledgement as the final answer.',
    'At most two inspections and four publication attempts are allowed for this human request. If relevant sources changed, inspect once more. When the app confirms that its bounded source limitation was already delivered, stop: do not send another answer, manufacture a new request or keep retrying. A delivery failure is not a completed reply.',
  ].join('\n');
}

/** Service context retains the human operation; it does not manufacture a new owner request. */
export function buildLeadReportContextRefresh(report: LeadReportRun | null): LeadContextRefresh {
  return {
    type: 'user' as const,
    isMeta: true,
    origin: { kind: 'coordinator' as const },
    message: {
      role: 'user' as const,
      content: [
        {
          type: 'text' as const,
          text: [
            buildLeadServiceRefreshInstruction(),
            report
              ? buildLeadReportRequestInstruction(report)
              : 'No pending human report request. Restore standing context without inventing a status request or sending a readiness acknowledgement.',
          ].join('\n\n'),
        },
      ],
    },
  };
}
