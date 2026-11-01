import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';

import { reportScopeForHumanRequest } from '../../core/domain/reportRequestIntent';

import { buildLeadReportRequestInstruction } from './reportInstructions';

import type { LeadReportRunIdentity } from '../../contracts';
import type { LeadReporting } from '../../core/application/LeadReporting';
import type { LeadReportDelivery, LeadReportSources } from '../../core/application/ports';

interface HumanRequest {
  readonly run: LeadReportRunIdentity;
  readonly requestMessageId: string;
  readonly text: string;
  readonly origin: Readonly<{ kind: 'human' }>;
  readonly isMeta: false;
}

interface Request {
  input: HumanRequest;
  preparing?: Promise<string>;
  instruction?: string;
  reportRunId?: string | null;
  replyText?: string;
  limitationText?: string;
  publishing?: Promise<Reply>;
  delivered?: Reply;
  notified: boolean;
}

interface Reply {
  readonly messageId: string;
  readonly requestMessageId: string;
}

/** Admitted human turns own reply routing; a model cannot choose an ordinary-report bypass. */
export class LeadRequestReporting {
  private readonly requests = new Map<string, Request>();
  private readonly active = new Map<string, Request>();

  constructor(
    private readonly deps: {
      reports: LeadReporting;
      sources: Pick<LeadReportSources, 'roster'>;
      delivery: LeadReportDelivery;
    }
  ) {}

  async accept(input: HumanRequest): Promise<string> {
    if (input.origin?.kind !== 'human' || input.isMeta !== false)
      throw new Error('Only an original human request can own a reply');
    if (!input.requestMessageId.trim() || input.requestMessageId.length > 256 || !input.text.trim())
      throw new Error('A bounded human request identity and text are required');
    const runKey = this.key(input.run);
    const key = JSON.stringify([runKey, input.requestMessageId]);
    let request = this.requests.get(key);
    if (request && request.input.text !== input.text)
      throw new Error('Request text is already bound');
    const current = this.active.get(runKey);
    if (current && current !== request && !current.notified)
      throw new Error('Previous human request is still active; queue this request until its turn');
    if (!request) {
      if (this.requests.size >= 200) {
        const completed = [...this.requests].find(
          ([, value]) => value.notified && !value.publishing
        );
        if (!completed) throw new Error('Too many unfinished human requests');
        this.requests.delete(completed[0]);
        const oldKey = this.key(completed[1].input.run);
        if (this.active.get(oldKey) === completed[1]) this.active.delete(oldKey);
      }
      request = { input: structuredClone(input), notified: false };
      this.requests.set(key, request);
      // Reserve before any source await. A failed read does not admit a successor turn.
      this.active.set(runKey, request);
    }
    if (request.instruction !== undefined) return request.instruction;
    if (request.preparing) return request.preparing;
    request.preparing = this.prepare(request);
    try {
      return await request.preparing;
    } finally {
      request.preparing = undefined;
    }
  }

  async reply(run: LeadReportRunIdentity, requestMessageId: string, text: string): Promise<Reply> {
    const request = this.active.get(this.key(run));
    if (request?.input.requestMessageId !== requestMessageId)
      throw new Error('No matching app-admitted human request is active');
    if (request.limitationText !== undefined)
      throw new Error('This request has an app-owned source limitation, not an ordinary reply');
    if (request.instruction === undefined)
      throw new Error('Human request admission is not complete');
    if (request.reportRunId)
      throw new Error('This request requires an inspected report, not an ordinary reply');
    if (!text.trim() || text.length > 32_000) throw new Error('A bounded reply is required');
    if (request.replyText !== undefined && request.replyText !== text)
      throw new Error('Request reply is already bound to different text');
    request.replyText = text;
    if (request.delivered) {
      this.notify(request);
      return { ...request.delivered };
    }
    if (request.publishing) return { ...(await request.publishing) };
    request.publishing = this.deliver(request, text);
    try {
      return { ...(await request.publishing) };
    } finally {
      request.publishing = undefined;
    }
  }

  /** Invoked by composition only after report delivery and its exact-request closure succeed. */
  completed(run: LeadReportRunIdentity, requestMessageId: string, messageId: string): void {
    const request = this.active.get(this.key(run));
    if (
      request?.input.requestMessageId !== requestMessageId ||
      !request.reportRunId ||
      messageId !== `lead-report:${request.reportRunId}`
    )
      return;
    request.delivered = { messageId, requestMessageId };
    request.notified = true;
  }

  private async prepare(request: Request): Promise<string> {
    const { input } = request;
    if (request.limitationText !== undefined) return this.deliverLimitation(request);
    let scope = reportScopeForHumanRequest(input.text, []);
    if (scope) {
      try {
        const roster = await this.deps.sources.roster(input.run);
        scope = reportScopeForHumanRequest(
          input.text,
          roster.members.filter((member) => member.role === 'member').map((member) => member.name)
        );
      } catch (error) {
        const reason =
          boundedDiagnosticString(error instanceof Error ? error.message : undefined) ??
          'No readable source diagnostic';
        request.limitationText = [
          'The saved team roster could not be read, so I cannot verify the complete team or report its progress.',
          `Roster read failed: ${reason}.`,
          'No member status, completed work or management action is confirmed by this failed read. The roster source must be readable before a new verified report can be made.',
        ].join('\n');
        return this.deliverLimitation(request);
      }
    }
    const report = scope
      ? this.deps.reports.begin({ run: input.run, requestMessageId: input.requestMessageId, scope })
      : null;
    request.reportRunId = report?.reportRunId ?? null;
    request.instruction = report
      ? buildLeadReportRequestInstruction(report)
      : `Human request: ${input.requestMessageId}. Answer the actual question through message_send to user with this requestMessageId. Plain assistant text is the internal work log. This request does not require a whole-team inspection.`;
    return request.instruction;
  }

  private async deliverLimitation(request: Request): Promise<string> {
    if (request.delivered) this.notify(request);
    else await this.deliver(request, request.limitationText!);
    request.instruction = `Human request ${request.input.requestMessageId}: a bounded source limitation was already delivered by the application. Do not send another answer for this request, invent a roster, or retry it in a loop. This failure does not authorize new actions.`;
    return request.instruction;
  }

  private async deliver(request: Request, text: string): Promise<Reply> {
    const { run, requestMessageId } = request.input;
    const messageId = `lead-reply:${run.runId}:${requestMessageId}`;
    const result = await this.deps.delivery.deliver({
      messageId,
      run,
      requestMessageId,
      inspectionId: '',
      text,
    });
    if (result.messageId !== messageId) throw new Error('Reply delivery identity differs');
    request.delivered = { messageId, requestMessageId };
    this.notify(request);
    return request.delivered;
  }

  private notify(request: Request): void {
    if (request.notified || !request.delivered) return;
    this.deps.delivery.delivered(request.input.run, { ...request.delivered, inspectionId: '' });
    request.notified = true;
  }

  private key(run: LeadReportRunIdentity): string {
    return JSON.stringify([
      run.appInstanceId,
      run.dataRootFingerprint,
      run.connectionGeneration,
      run.teamName,
      run.runId,
    ]);
  }
}
