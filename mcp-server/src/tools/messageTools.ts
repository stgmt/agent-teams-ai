import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getController } from '../controller';
import { registerGroupChatTools } from './groupChatTools';
import { assertConfiguredTeam } from '../utils/teamConfig';
import { jsonTextContent } from '../utils/format';
import { taskRefSchema } from '../utils/schemas';

const toolContextSchema = {
  teamName: z.string().min(1),
  claudeDir: z.string().min(1).optional(),
};

export function registerMessageTools(server: Pick<FastMCP, 'addTool'>) {
  registerGroupChatTools(server);
  server.addTool({
    name: 'message_send',
    description:
      'Send a visible team/user message into team inbox. OpenCode teammates should use this for normal replies to the human user, lead, or same-team teammates. from is required and must be your configured teammate name; user is reserved for app-owned writes. For an app-admitted human request, include its exact requestMessageId for an ordinary answer or provide the structured report from lead_briefing. When replying to an app-delivered OpenCode runtime message, include source="runtime_delivery" and relayOfMessageId with the inbound app messageId. After a successful app-delivered runtime reply, stop and do not send the same answer again. Do not invent placeholder task refs. If the message is not about a real board task, omit # task labels; never use #00000000.',
    parameters: z.object({
      ...toolContextSchema,
      to: z.string().min(1),
      text: z.string().min(1),
      from: z.string().min(1),
      summary: z.string().optional(),
      source: z.string().optional(),
      relayOfMessageId: z.string().optional(),
      leadSessionId: z.string().optional(),
      requestMessageId: z.string().min(1).max(256).optional(),
      report: z
        .object({
          inspectionId: z.string().min(1).max(256),
          summary: z.string().trim().min(1).max(4000),
          members: z
            .array(
              z
                .object({
                  memberName: z.string().min(1).max(200),
                  statements: z
                    .array(
                      z
                        .object({
                          kind: z.enum(['result', 'blocker', 'action', 'observation']),
                          text: z.string().trim().min(1).max(4000),
                          evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(100),
                        })
                        .strict()
                    )
                    .min(1)
                    .max(20),
                })
                .strict()
            )
            .max(200),
          nextStep: z.string().trim().min(1).max(4000),
        })
        .strict()
        .optional(),
      attachments: z
        .array(
          z.object({
            id: z.string().min(1),
            filename: z.string().min(1),
            mimeType: z.string().min(1),
            size: z.number().nonnegative(),
            filePath: z.string().min(1).optional(),
          })
        )
        .optional(),
      taskRefs: z.array(taskRefSchema).optional(),
    }),
    execute: async ({
      teamName,
      claudeDir,
      to,
      text,
      from,
      summary,
      source,
      relayOfMessageId,
      leadSessionId,
      requestMessageId,
      report,
      attachments,
      taskRefs,
    }) => {
      assertConfiguredTeam(teamName, claudeDir);
      const result = await getController(teamName, claudeDir).messages.sendMessage({
        to,
        text,
        ...(from ? { from } : {}),
        ...(summary ? { summary } : {}),
        ...(source ? { source } : {}),
        ...(relayOfMessageId ? { relayOfMessageId } : {}),
        ...(leadSessionId ? { leadSessionId } : {}),
        ...(requestMessageId ? { requestMessageId } : {}),
        ...(report ? { report } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(taskRefs?.length ? { taskRefs } : {}),
      });
      const deduplicated =
        result &&
        typeof result === 'object' &&
        (result as { deduplicated?: unknown }).deduplicated === true;
      let protocolInstruction =
        'Delivered. If this answered one app/user instruction, do not call message_send again for the same answer.';
      if (deduplicated) {
        protocolInstruction =
          'Not delivered again: the recipient already has this message (see deduplicationNotice). Stop this turn now; do not resend or rephrase it.';
      } else if (source === 'runtime_delivery' || relayOfMessageId) {
        protocolInstruction =
          'Delivered as an app-delivered runtime reply. Stop this turn now; do not call message_send again for the same inbound message.';
      }
      const payload =
        result && typeof result === 'object' && !Array.isArray(result)
          ? { ...(result as Record<string, unknown>), protocolInstruction }
          : { result, protocolInstruction };
      return await Promise.resolve(jsonTextContent(payload));
    },
  });
}
