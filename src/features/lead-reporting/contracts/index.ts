import type { TeamRunIdentity } from '@features/team-provisioning/contracts';

export type LeadReportRunIdentity = Readonly<TeamRunIdentity>;
export type LeadReportScope =
  | Readonly<{ kind: 'team' }>
  | Readonly<{ kind: 'members'; memberNames: readonly string[] }>;

export interface LeadReportRun {
  readonly reportRunId: string;
  readonly run: LeadReportRunIdentity;
  readonly requestMessageId: string;
  readonly scope: LeadReportScope;
}

export interface SourceStamp {
  readonly source: string;
  readonly revision: string;
  readonly observedAt: string;
}

export interface SourceError {
  readonly source: 'lifecycle' | 'tasks' | 'results';
  readonly code: string;
  readonly memberName?: string;
  readonly taskId?: string;
  readonly detail?: string;
}

export interface EvidenceRef {
  readonly evidenceId: string;
  readonly source: SourceStamp;
  readonly locator: string;
  readonly memberName: string;
  readonly taskId?: string;
  readonly topic: 'process' | 'work' | 'result' | 'blocker' | 'action';
  readonly verification: 'observed' | 'reported' | 'verified';
  readonly description: string;
  readonly occurredAt: string | null;
}

export interface ProcessObservation {
  readonly source: SourceStamp | null;
  readonly phase:
    | 'unknown'
    | 'stopped'
    | 'starting'
    | 'connecting'
    | 'ready'
    | 'unresponsive'
    | 'stopping'
    | 'exited'
    | 'failed';
  readonly generation: number | null;
  readonly operationId: string | null;
  readonly everConnected: boolean | null;
  readonly error: string | null;
  readonly evidence?: EvidenceRef;
}

export interface TaskObservation {
  readonly taskId: string;
  readonly subject: string;
  readonly status: string;
  readonly source: SourceStamp;
  readonly evidence: readonly EvidenceRef[];
}

export interface MemberInspection {
  readonly name: string;
  readonly process: ProcessObservation;
  readonly tasks: readonly TaskObservation[];
  readonly blockers: readonly EvidenceRef[];
  readonly reportedResults: readonly EvidenceRef[];
  readonly verifiedResults: readonly EvidenceRef[];
}

export interface LeadReportFacts {
  readonly run: LeadReportRunIdentity;
  readonly observedAt: string;
  readonly roster: SourceStamp;
  readonly scope: LeadReportScope;
  readonly members: readonly MemberInspection[];
  readonly changesSinceLastReport: readonly Readonly<{
    memberName: string;
    areas: readonly ('process' | 'tasks' | 'results')[];
  }>[];
  readonly comparedToMessageId: string | null;
  readonly sourceErrors: readonly SourceError[];
}

export interface LeadInspection extends LeadReportFacts {
  readonly inspectionId: string;
  readonly reportRunId: string;
}

export type LeadBriefing =
  | Readonly<{ kind: 'report'; inspection: LeadInspection }>
  | Readonly<{ kind: 'management'; inspection: LeadReportFacts }>;

export interface ReportStatement {
  readonly text: string;
  readonly evidenceIds: readonly string[];
  readonly kind: 'result' | 'blocker' | 'action' | 'observation';
}

export interface LeadReportDraft {
  readonly inspectionId: string;
  readonly summary: string;
  readonly members: readonly Readonly<{
    memberName: string;
    statements: readonly ReportStatement[];
  }>[];
  readonly nextStep: string;
}

export interface DeliveredLeadReport {
  readonly messageId: string;
  readonly requestMessageId: string;
  readonly inspectionId: string;
}

export interface LeadReportingApi {
  briefing(credential: string): Promise<LeadBriefing>;
  inspect(credential: string, reportRunId: string): Promise<LeadInspection>;
  publish(credential: string, draft: LeadReportDraft): Promise<DeliveredLeadReport>;
}
