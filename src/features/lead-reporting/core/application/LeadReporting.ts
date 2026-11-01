import {
  factKey,
  renderReport,
  renderReportLimitation,
  sameRun,
  validateDraft,
} from '../domain/reportFacts';

import { collectInspection } from './collectInspection';

import type {
  DeliveredLeadReport,
  LeadBriefing,
  LeadInspection,
  LeadReportDraft,
  LeadReportRun,
  LeadReportRunIdentity,
} from '../../contracts';
import type { BeginLeadReport, LeadReportDependencies } from './ports';

interface Operation {
  report: LeadReportRun;
  inspection?: LeadInspection;
  delivered?: DeliveredLeadReport;
  deliveredDraft?: string;
  publishing?: Promise<DeliveredLeadReport>;
  publishingDraft?: string;
  notificationPending?: boolean;
  inspectionAttempts: number;
  publicationAttempts: number;
  terminalReason?: string;
  preparedDelivery?: {
    draftKey: string;
    input: Parameters<LeadReportDependencies['delivery']['deliver']>[0];
  };
}

function runKey(run: LeadReportRunIdentity): string {
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
  ]);
}

function baselineKey(report: LeadReportRun): string {
  return JSON.stringify([
    runKey(report.run),
    report.scope.kind,
    report.scope.kind === 'members'
      ? [...report.scope.memberNames].sort((a, b) => a.localeCompare(b))
      : [],
  ]);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Owns report operations and receipts, never process state or the team roster. */
export class LeadReporting {
  private readonly operations = new Map<string, Operation>();
  private readonly receipts = new Map<string, string>();
  private readonly baselines = new Map<string, { messageId: string; inspection: LeadInspection }>();
  private readonly active = new Map<string, string>();
  private readonly inspections = new Map<string, Promise<LeadInspection>>();

  constructor(private readonly deps: LeadReportDependencies) {
    if (!Number.isSafeInteger(deps.maxInspectionAgeMs) || deps.maxInspectionAgeMs < 1)
      throw new Error('A positive inspection age limit is required');
    if (!Number.isSafeInteger(deps.maxSourceWaitMs) || deps.maxSourceWaitMs < 1)
      throw new Error('A positive source wait limit is required');
  }

  /** App-owned human request routing calls this; it is not an agent tool. */
  begin(input: BeginLeadReport): LeadReportRun {
    if (!input.requestMessageId.trim()) throw new Error('A human request identity is required');
    for (const operation of this.operations.values()) {
      if (
        sameRun(operation.report.run, input.run) &&
        operation.report.requestMessageId === input.requestMessageId
      ) {
        if (factKey(operation.report.scope) !== factKey(input.scope))
          throw new Error('Report scope already bound');
        return copy(operation.report);
      }
    }
    const currentId = this.active.get(runKey(input.run));
    const current = currentId ? this.operations.get(currentId) : undefined;
    if (current && (!current.delivered || current.publishing || current.notificationPending))
      throw new Error('Previous report request is still active');
    if (this.operations.size >= 200) {
      const oldest = [...this.operations].find(
        ([, operation]) =>
          operation.delivered && !operation.publishing && !operation.notificationPending
      );
      if (!oldest) throw new Error('Too many unfinished report operations');
      if (oldest[1].inspection) this.receipts.delete(oldest[1].inspection.inspectionId);
      this.dropBaseline(oldest[0], oldest[1]);
      this.operations.delete(oldest[0]);
      const oldRunKey = runKey(oldest[1].report.run);
      if (this.active.get(oldRunKey) === oldest[0]) this.active.delete(oldRunKey);
    }
    const report: LeadReportRun = copy({ ...input, reportRunId: this.deps.newId() });
    if (this.operations.has(report.reportRunId))
      throw new Error('Duplicate report operation identity');
    this.operations.set(report.reportRunId, {
      report,
      inspectionAttempts: 0,
      publicationAttempts: 0,
    });
    this.active.set(runKey(input.run), report.reportRunId);
    return copy(report);
  }

  current(credential: string): LeadReportRun | null {
    const run = this.deps.resolveLead(credential);
    const id = this.active.get(runKey(run));
    if (!id) return null;
    const operation = this.operation(run, id);
    return operation.delivered ? null : copy(operation.report);
  }

  /** Management reads reuse the fact collector, but never issue a publication receipt. */
  async briefing(credential: string): Promise<LeadBriefing> {
    const run = this.deps.resolveLead(credential);
    const activeOperation = this.operations.get(this.active.get(runKey(run)) ?? '');
    if (
      activeOperation?.terminalReason &&
      (!activeOperation.delivered || activeOperation.notificationPending)
    )
      return this.limit(credential, activeOperation);
    const current = this.current(credential);
    if (current)
      return { kind: 'report', inspection: await this.inspect(credential, current.reportRunId) };
    const activeId = this.active.get(runKey(run));
    const report = { run, scope: { kind: 'team' as const } };
    const inspection = await collectInspection(this.deps, report);
    if (!sameRun(this.deps.resolveLead(credential), run))
      throw new Error('Lead run changed during management briefing');
    if (this.active.get(runKey(run)) !== activeId)
      throw new Error('Human report request changed during management briefing; inspect again');
    return { kind: 'management', inspection };
  }

  async inspect(credential: string, reportRunId: string): Promise<LeadInspection> {
    const run = this.deps.resolveLead(credential);
    const operation = this.operation(run, reportRunId);
    // A client retry after a transport timeout shares the same read instead of
    // replacing an inspection receipt another response may still be using.
    const running = this.inspections.get(reportRunId);
    if (running) return copy(await running);
    const task = this.runInspection(credential, run, operation);
    this.inspections.set(reportRunId, task);
    try {
      return copy(await task);
    } finally {
      this.inspections.delete(reportRunId);
    }
  }

  /** Closes an abandoned operation without delivering a second user-facing message. */
  abandon(run: LeadReportRunIdentity, reportRunId: string): void {
    const operation = this.operations.get(reportRunId);
    if (!operation || !sameRun(operation.report.run, run)) return;
    if (operation.inspection) this.receipts.delete(operation.inspection.inspectionId);
    this.dropBaseline(reportRunId, operation);
    this.operations.delete(reportRunId);
    const key = runKey(run);
    if (this.active.get(key) === reportRunId) this.active.delete(key);
  }

  /** A report already in the inbox must never be replaced by a timeout limitation. */
  deliveredReport(run: LeadReportRunIdentity, reportRunId: string): DeliveredLeadReport | null {
    const operation = this.operations.get(reportRunId);
    if (!operation || !sameRun(operation.report.run, run) || !operation.delivered) return null;
    return copy(operation.delivered);
  }

  private async runInspection(
    credential: string,
    run: LeadReportRunIdentity,
    operation: Operation
  ): Promise<LeadInspection> {
    const reportRunId = operation.report.reportRunId;
    if (operation.terminalReason) return this.limit(credential, operation);
    if (operation.delivered || operation.publishing || operation.preparedDelivery)
      throw new Error('Report operation is already publishing or delivered');
    if (operation.inspectionAttempts >= 2)
      return this.limit(credential, operation, 'inspection attempt limit');
    operation.inspectionAttempts++;
    const inspectionId = this.deps.newId();
    let facts: Awaited<ReturnType<typeof collectInspection>>;
    try {
      facts = await collectInspection(
        this.deps,
        operation.report,
        this.baselines.get(baselineKey(operation.report))
      );
    } catch (error) {
      // The last allowed read failed: close the original request with one honest limitation
      // instead of waiting for the model to attempt a third call it is not allowed to make.
      if (
        operation.inspectionAttempts >= 2 &&
        !operation.delivered &&
        !operation.publishing &&
        !operation.terminalReason
      )
        return this.limit(credential, operation, 'inspection attempt limit');
      throw error;
    }
    if (!this.operations.has(reportRunId)) throw new Error('Report operation is closed');
    const inspection: LeadInspection = { ...facts, inspectionId, reportRunId };
    if (!sameRun(this.deps.resolveLead(credential), run))
      throw new Error('Lead run changed during inspection');
    if (
      operation.delivered ||
      operation.publishing ||
      operation.terminalReason ||
      operation.preparedDelivery
    )
      throw new Error('Report operation changed during inspection');
    if (operation.inspection) this.receipts.delete(operation.inspection.inspectionId);
    if (this.receipts.has(inspection.inspectionId))
      throw new Error('Duplicate inspection identity');
    operation.inspection = copy(inspection);
    this.receipts.set(inspection.inspectionId, reportRunId);
    return inspection;
  }

  async publish(credential: string, input: LeadReportDraft): Promise<DeliveredLeadReport> {
    const run = this.deps.resolveLead(credential);
    const draft = copy(input);
    const id = this.receipts.get(draft.inspectionId);
    if (!id) throw new Error('Unknown inspection receipt');
    const operation = this.operation(run, id);
    if (operation.terminalReason) return this.limit(credential, operation);
    const draftKey = JSON.stringify(draft);
    if (operation.delivered) {
      if (operation.deliveredDraft !== draftKey)
        throw new Error('Delivered report cannot be replaced');
      this.notify(operation);
      return copy(operation.delivered);
    }
    if (operation.publishing) {
      if (operation.publishingDraft !== draftKey)
        throw new Error('Report publication already in progress');
      return copy(await operation.publishing);
    }
    if (operation.preparedDelivery) {
      if (operation.preparedDelivery.draftKey !== draftKey)
        throw new Error('Prepared report delivery cannot be replaced');
    } else {
      if (operation.publicationAttempts >= 4)
        return this.limit(credential, operation, 'publication correction limit');
      operation.publicationAttempts++;
    }
    operation.publishingDraft = draftKey;
    operation.publishing = this.deliver(credential, operation, draft, draftKey);
    try {
      return copy(await operation.publishing);
    } finally {
      operation.publishing = undefined;
      operation.publishingDraft = undefined;
    }
  }

  private operation(run: LeadReportRunIdentity, id: string): Operation {
    const operation = this.operations.get(id);
    if (!operation || !sameRun(operation.report.run, run)) throw new Error('Unknown report run');
    return operation;
  }

  /** A retained report keeps its baseline; eviction must not pin the last facts forever. */
  private dropBaseline(operationId: string, operation: Operation): void {
    const key = baselineKey(operation.report);
    if (this.baselines.get(key)?.messageId === `lead-report:${operationId}`)
      this.baselines.delete(key);
  }

  private notify(operation: Operation): void {
    if (!operation.notificationPending || !operation.delivered) return;
    this.deps.delivery.delivered(operation.report.run, copy(operation.delivered));
    operation.notificationPending = false;
  }

  private async deliver(
    credential: string,
    operation: Operation,
    draft: LeadReportDraft,
    draftKey: string
  ): Promise<DeliveredLeadReport> {
    if (operation.preparedDelivery)
      return this.append(credential, operation, operation.preparedDelivery.input, draftKey);
    const inspection = operation.inspection;
    if (inspection?.inspectionId !== draft.inspectionId)
      throw new Error('Inspection receipt is no longer current');
    const age = Date.parse(this.deps.now()) - Date.parse(inspection.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > this.deps.maxInspectionAgeMs)
      throw new Error('Inspection expired; inspect again');
    validateDraft(inspection, draft);
    const fresh = await collectInspection(this.deps, operation.report);
    // A status report is a point-in-time snapshot. Membership, process state and source
    // availability must still hold; ordinary board churn must not turn an active team into a
    // permanent "inspect again".
    const processFacts = (members: LeadInspection['members']) =>
      members.map((member) => ({ name: member.name, process: member.process }));
    if (
      fresh.roster.revision !== inspection.roster.revision ||
      factKey(processFacts(fresh.members)) !== factKey(processFacts(inspection.members)) ||
      factKey(fresh.sourceErrors) !== factKey(inspection.sourceErrors)
    )
      throw new Error('Report roster, process state or source availability changed; inspect again');
    const finalAge = Date.parse(this.deps.now()) - Date.parse(inspection.observedAt);
    if (!Number.isFinite(finalAge) || finalAge < 0 || finalAge > this.deps.maxInspectionAgeMs)
      throw new Error('Inspection expired during source revalidation; inspect again');
    if (!sameRun(this.deps.resolveLead(credential), operation.report.run))
      throw new Error('Lead run changed before publication');
    const input = {
      messageId: `lead-report:${this.deps.fingerprint(
        `${runKey(operation.report.run)}:${operation.report.requestMessageId}`
      )}`,
      run: operation.report.run,
      requestMessageId: operation.report.requestMessageId,
      inspectionId: inspection.inspectionId,
      text: renderReport(inspection, draft),
    };
    operation.preparedDelivery = { draftKey, input };
    return this.append(credential, operation, input, draftKey);
  }

  private async limit(credential: string, operation: Operation, reason?: string): Promise<never> {
    operation.terminalReason ??= reason;
    if (operation.delivered) this.notify(operation);
    else if (operation.publishing) await operation.publishing;
    else {
      const input = {
        messageId: `lead-report:${this.deps.fingerprint(
          `${runKey(operation.report.run)}:${operation.report.requestMessageId}`
        )}`,
        run: operation.report.run,
        requestMessageId: operation.report.requestMessageId,
        inspectionId: operation.inspection?.inspectionId ?? '',
        text: renderReportLimitation(operation.terminalReason),
      };
      operation.publishing = this.append(credential, operation, input);
      try {
        await operation.publishing;
      } finally {
        operation.publishing = undefined;
      }
    }
    throw new Error('Report source limitation was already delivered; do not retry this request');
  }

  private async append(
    credential: string,
    operation: Operation,
    input: Parameters<LeadReportDependencies['delivery']['deliver']>[0],
    draftKey?: string
  ): Promise<DeliveredLeadReport> {
    if (!sameRun(this.deps.resolveLead(credential), operation.report.run))
      throw new Error('Lead run changed before inbox append');
    const result = await this.deps.delivery.deliver(copy(input));
    if (result.messageId !== input.messageId)
      throw new Error('Delivery did not confirm the report message identity');
    operation.delivered = {
      messageId: input.messageId,
      requestMessageId: input.requestMessageId,
      inspectionId: input.inspectionId,
    };
    operation.deliveredDraft = draftKey;
    operation.notificationPending = true;
    if (!operation.terminalReason && operation.inspection)
      this.baselines.set(baselineKey(operation.report), {
        messageId: input.messageId,
        inspection: copy(operation.inspection),
      });
    this.notify(operation);
    return operation.delivered;
  }
}
