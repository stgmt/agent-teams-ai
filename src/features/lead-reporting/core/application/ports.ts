import type {
  DeliveredLeadReport,
  EvidenceRef,
  LeadReportRunIdentity,
  LeadReportScope,
  SourceError,
  SourceStamp,
} from '../../contracts';
import type { TeamLifecycleSnapshot } from '@features/team-provisioning/contracts';

export interface RosterRead {
  readonly source: SourceStamp;
  readonly members: readonly Readonly<{ name: string; role: 'lead' | 'member' }>[];
}

export interface TasksRead {
  readonly source: SourceStamp;
  readonly tasks: readonly Readonly<{
    memberName: string;
    taskId: string;
    subject: string;
    status: string;
    source: SourceStamp;
    evidence: readonly EvidenceRef[];
  }>[];
}

export interface ResultsRead {
  readonly source: SourceStamp;
  readonly evidence: readonly EvidenceRef[];
  readonly errors?: readonly SourceError[];
}

/** Source adapters provide only bounded, redacted diagnostics across this port. */
export class LeadReportSourceFailure extends Error {
  constructor(readonly diagnostic: Readonly<SourceError>) {
    super(diagnostic.detail ?? diagnostic.code);
  }
}

export interface LeadReportSources {
  roster(run: LeadReportRunIdentity): Promise<RosterRead>;
  lifecycle(run: LeadReportRunIdentity): Promise<Readonly<TeamLifecycleSnapshot> | null>;
  tasks(run: LeadReportRunIdentity): Promise<TasksRead>;
  results(run: LeadReportRunIdentity): Promise<ResultsRead>;
}

export interface LeadReportDelivery {
  /** Must be idempotent on messageId. Resolves only after the inbox append succeeds. */
  deliver(
    input: Readonly<{
      messageId: string;
      run: LeadReportRunIdentity;
      requestMessageId: string;
      inspectionId: string;
      text: string;
    }>
  ): Promise<Readonly<{ messageId: string }>>;
  /** Closes this request, never all pending requests or an acknowledgement. */
  delivered(run: LeadReportRunIdentity, report: DeliveredLeadReport): void;
}

export interface LeadReportDependencies {
  resolveLead(credential: string): LeadReportRunIdentity;
  sources: LeadReportSources;
  delivery: LeadReportDelivery;
  now(): string;
  newId(): string;
  /** Deterministic short identity for a run-bound request; retries must reuse it. */
  fingerprint(value: string): string;
  maxInspectionAgeMs: number;
  /** One budget shared by every source read of an inspection, including the roster. */
  maxSourceWaitMs: number;
}

export interface BeginLeadReport {
  readonly run: LeadReportRunIdentity;
  readonly requestMessageId: string;
  readonly scope: LeadReportScope;
}
