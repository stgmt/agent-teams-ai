import { dirname } from 'node:path';

import { controllerModule } from './controllerModuleInterop';

import type { DeliveredLeadReport, LeadReportRunIdentity } from '../../../contracts';
import type { LeadReportDelivery } from '../../../core/application/ports';


/** Only this app-side adapter writes user reports. MCP never appends them independently. */
export class NodeLeadReportDelivery implements LeadReportDelivery {
  constructor(
    private readonly deps: {
      teamsRoot: string;
      leadName(run: LeadReportRunIdentity): Promise<string>;
      assertCurrentRun(run: LeadReportRunIdentity): Promise<void>;
      delivered(run: LeadReportRunIdentity, report: DeliveredLeadReport): void;
      changed(teamName: string): void;
    }
  ) {}

  async deliver(
    input: Parameters<LeadReportDelivery['deliver']>[0]
  ): Promise<{ messageId: string }> {
    const from = await this.deps.leadName(input.run);
    await this.deps.assertCurrentRun(input.run);
    const controller = controllerModule.createController({
      teamName: input.run.teamName,
      claudeDir: dirname(this.deps.teamsRoot),
      allowUserMessageSender: true,
    });
    const result = await controller.messages.sendMessageAsync({
      from,
      to: 'user',
      text: input.text,
      messageId: input.messageId,
      replyToMessageIds: [input.requestMessageId],
      replyChannel: 'explicit',
      source: 'lead_process',
      leadSessionId: input.run.runId,
      // A distinct human request may legitimately have the same unchanged report text.
      allowRepeatedDelivery: true,
    });
    if (
      !result ||
      typeof result !== 'object' ||
      !('messageId' in result) ||
      result.messageId !== input.messageId ||
      !('deliveredToInbox' in result) ||
      result.deliveredToInbox !== true
    )
      throw new Error('Report inbox append did not confirm delivery');
    const message = 'message' in result ? result.message : null;
    if (
      !message ||
      typeof message !== 'object' ||
      !('text' in message) ||
      message.text !== input.text ||
      !('from' in message) ||
      message.from !== from ||
      !('replyChannel' in message) ||
      message.replyChannel !== 'explicit' ||
      !('leadSessionId' in message) ||
      message.leadSessionId !== input.run.runId ||
      !('replyToMessageIds' in message) ||
      !Array.isArray(message.replyToMessageIds) ||
      message.replyToMessageIds.length !== 1 ||
      message.replyToMessageIds[0] !== input.requestMessageId
    )
      throw new Error('Persisted reply content differs from this request');
    return { messageId: input.messageId };
  }

  delivered(run: LeadReportRunIdentity, report: DeliveredLeadReport): void {
    this.deps.changed(run.teamName);
    this.deps.delivered(run, report);
  }
}
