import {
  admitNativeTeammateAttachmentIpcMessage,
  assertAttachmentRecipientOnline,
  getNativeAttachmentRecipientRestriction,
  prepareMessageAttachments,
  selectNativeMessageAttachments,
  validateAgentAttachmentIpcPayload,
  validateAgentAttachmentSerializedIpcPayload,
} from '@features/agent-attachments/main';
import { isAgentActionMode } from '@main/services/team/actionModeInstructions';
import { buildDirectUserMessageReplyInstruction } from '@main/services/team/leadUserReplyChannel';
import {
  buildMessageDeliveryText,
  buildOriginalUserRequestBlock,
} from '@main/services/team/messageDeliveryText';
import { buildOpenCodeRuntimeDeliveryUserVisibleImpact } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { buildLeadRosterContextBlock } from '@main/services/team/provisioning/TeamProvisioningLeadRosterContext';
import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import {
  buildStandaloneSlashCommandMeta,
  parseStandaloneSlashCommand,
} from '@shared/utils/slashCommands';
import crypto from 'crypto';
import { type IpcMainInvokeEvent } from 'electron';
import * as path from 'path';

import {
  validateFromField,
  validateMemberName,
  validateMessageId,
  validateTeamName,
} from '../guards';

import { waitForOpenCodeRuntimeRelayForUi } from './openCodeRuntimeDeliveryRelayUi';

import type { ResolveOpenCodeInputDeclaration } from '@features/agent-attachments';
import type { TeamDataService } from '@main/services';
import type {
  TeamDiagnosticsApi,
  TeamMemberLifecycleApi,
  TeamMessagingApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  AgentActionMode,
  AttachmentPayload,
  IpcResult,
  SendMessageRequest,
  SendMessageResult,
  TaskRef,
  TeamProviderId,
} from '@shared/types';

const logger = createLogger('IPC:teams');

type VisibleDirectReplyProtocol = 'send_message' | 'agent_teams_message_send';

function resolveVisibleDirectReplyProtocol(input: {
  providerId?: TeamProviderId;
  isLeadRecipient: boolean;
  replyRecipient: string;
}): VisibleDirectReplyProtocol {
  if (
    !input.isLeadRecipient &&
    input.replyRecipient.trim().toLowerCase() === 'user' &&
    input.providerId === 'codex'
  ) {
    return 'agent_teams_message_send';
  }

  return 'send_message';
}

function buildLeadDirectDelegateAckBlock(actionMode?: AgentActionMode): string | null {
  if (actionMode !== 'delegate') return null;

  return wrapAgentBlock(
    [
      'DELEGATE MODE USER ACK CONTRACT:',
      'Before any task creation, delegation, or other tool use, begin your next assistant response with one short human-readable acknowledgement to the user.',
      'That acknowledgement must be visible plain text, not only an agent-only block.',
      'Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.',
      'After that visible acknowledgement, continue with delegation/orchestration in the same turn.',
    ].join('\n')
  );
}
function formatAttachmentDeliveryFailure(error: unknown, teamStillAlive: boolean): string {
  if (!teamStillAlive) {
    return 'Failed to deliver message with attachments: team process became unavailable';
  }
  const message = getErrorMessage(error);
  if (message.startsWith('Failed to deliver message with attachments:')) {
    return message;
  }
  return `Failed to deliver message with attachments: ${message}`;
}
export interface TeamLeadMessageDeliveryDependencies {
  getTeamDataService(): Pick<
    TeamDataService,
    | 'getLeadMemberName'
    | 'getTeamData'
    | 'sendDirectToLead'
    | 'sendMessage'
    | 'sendRuntimeRecipientMessage'
  >;
  getTeamMessagingApi(): TeamMessagingApi;
  getTeamRuntimeApi(): TeamRuntimeApi;
  getTeamDiagnosticsApi(): TeamDiagnosticsApi;
  getTeamMemberLifecycleApi(): Pick<TeamMemberLifecycleApi, 'runLiveRosterMutation'>;
  getInputDeclarationResolver(): ResolveOpenCodeInputDeclaration | undefined;
  attachmentStore: TeamAttachmentStore;
  validateTaskRefs(
    value: unknown
  ): { valid: true; value: TaskRef[] | undefined } | { valid: false; error: string };
  wrapTeamHandler<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>>;
}

/** Human delivery keeps live SDK outcomes separate from inbox admission. */
export function createTeamLeadMessageDelivery(deps: TeamLeadMessageDeliveryDependencies) {
  async function getDurableLeadTeammateRoster(
    teamName: string,
    leadName: string
  ): Promise<{ name: string; role?: string }[]> {
    const normalize = (name: string | undefined | null): string => name?.trim().toLowerCase() ?? '';
    const leadLower = normalize(leadName);
    const reserved = new Set(['team-lead', 'user', leadLower].filter((value) => value.length > 0));

    try {
      const members = await new TeamMembersMetaStore().getMembers(teamName);
      const teammates = members
        .filter((member) => !member.removedAt)
        .filter((member) => {
          const lower = normalize(member.name);
          return lower.length > 0 && !reserved.has(lower);
        })
        .map((member) => ({
          name: member.name.trim(),
          role:
            typeof member.role === 'string' && member.role.trim().length > 0
              ? member.role.trim()
              : undefined,
        }));
      if (teammates.length > 0) return teammates;
    } catch (error) {
      logger.debug(
        `[teams:sendMessage] Failed to read members.meta roster for "${teamName}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    try {
      const data = await getTeamDataService().getTeamData(teamName);
      return data.members
        .filter((member) => !member.removedAt)
        .filter((member) => {
          const lower = normalize(member.name);
          return lower.length > 0 && !reserved.has(lower);
        })
        .map((member) => ({
          name: member.name.trim(),
          role:
            typeof member.role === 'string' && member.role.trim().length > 0
              ? member.role.trim()
              : undefined,
        }));
    } catch (error) {
      logger.debug(
        `[teams:sendMessage] Failed to read fallback team roster for "${teamName}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  }

  const {
    getTeamDataService,
    getTeamMessagingApi,
    getTeamRuntimeApi,
    getTeamDiagnosticsApi,
    getTeamMemberLifecycleApi,
    attachmentStore,
    validateTaskRefs,
    wrapTeamHandler,
  } = deps;
  async function handleSendMessage(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    request: unknown
  ): Promise<IpcResult<SendMessageResult>> {
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
    }

    if (!request || typeof request !== 'object')
      return { success: false, error: 'Invalid send message request' };

    const payload = request as Partial<SendMessageRequest>;
    const validatedMember = validateMemberName(payload.member);
    if (!validatedMember.valid)
      return { success: false, error: validatedMember.error ?? 'Invalid member' };
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0)
      return { success: false, error: 'text must be non-empty string' };
    if (payload.text.length > MAX_TEXT_LENGTH)
      return { success: false, error: `Text exceeds ${MAX_TEXT_LENGTH} characters` };
    if (payload.summary !== undefined && typeof payload.summary !== 'string')
      return { success: false, error: 'summary must be string' };
    if (payload.from !== undefined) {
      const validatedFrom = validateFromField(payload.from);
      if (!validatedFrom.valid)
        return { success: false, error: validatedFrom.error ?? 'Invalid from' };
    }
    if (payload.actionMode !== undefined && !isAgentActionMode(payload.actionMode)) {
      return { success: false, error: 'actionMode must be one of: do, ask, delegate' };
    }
    const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
    if (!validatedTaskRefs.valid) return { success: false, error: validatedTaskRefs.error };
    const validatedMessageId =
      payload.messageId === undefined ? undefined : validateMessageId(payload.messageId);
    if (validatedMessageId && !validatedMessageId.valid)
      return { success: false, error: validatedMessageId.error ?? 'Invalid messageId' };

    let validatedAttachments: AttachmentPayload[] | undefined;
    if ('fileReferences' in payload || 'nativeAttachmentDelivery' in payload) {
      return { success: false, error: 'Attachment delivery metadata is main-owned' };
    }
    if (payload.attachments !== undefined) {
      const attResult = validateAgentAttachmentIpcPayload(payload.attachments);
      if (!attResult.valid) {
        return { success: false, error: attResult.error };
      }
      validatedAttachments = attResult.value;
      if (
        validatedAttachments.length &&
        ((payload.from !== undefined && payload.from.trim().toLowerCase() !== 'user') ||
          (payload.source !== undefined && payload.source !== 'user_sent'))
      ) {
        return { success: false, error: 'Message file attachments require user origin' };
      }
      if (!validatedAttachments.some((attachment) => attachment.mimeType.startsWith('video/'))) {
        const serialized = validateAgentAttachmentSerializedIpcPayload({
          text: payload.text,
          attachments: validatedAttachments,
        });
        if (!serialized.valid) return { success: false, error: serialized.error };
      }
    }

    const tn = validatedTeamName.value!;
    const memberName = validatedMember.value!;
    let prevalidatedLeadName: string | null | undefined;
    let prevalidatedIsLeadRecipient: boolean | undefined;
    if (payload.actionMode === 'delegate') {
      try {
        prevalidatedLeadName = await getTeamDataService().getLeadMemberName(tn);
      } catch (error) {
        return wrapTeamHandler('sendMessage', async () => {
          throw error;
        });
      }
      prevalidatedIsLeadRecipient =
        prevalidatedLeadName !== null && memberName === prevalidatedLeadName;
      if (!prevalidatedIsLeadRecipient) {
        return {
          success: false,
          error: 'Delegate mode is only supported when messaging the team lead',
        };
      }
    }

    return wrapTeamHandler('sendMessage', async () => {
      const messaging = getTeamMessagingApi();
      const runtime = getTeamRuntimeApi();
      const isAlive = runtime.isTeamAlive(tn);

      const leadName =
        prevalidatedLeadName !== undefined
          ? prevalidatedLeadName
          : await getTeamDataService().getLeadMemberName(tn);
      const isLeadRecipient =
        prevalidatedIsLeadRecipient !== undefined
          ? prevalidatedIsLeadRecipient
          : leadName !== null && memberName === leadName;
      const actionMode = payload.actionMode ?? 'do';

      const recipientProviderId = await messaging.resolveRuntimeRecipientProviderId(tn, memberName);
      if (!recipientProviderId) {
        throw new Error(`Cannot determine runtime provider for recipient "${memberName}"`);
      }
      const isOpenCodeRecipient = recipientProviderId === 'opencode';
      if (validatedAttachments?.length) {
        const nativeAttachments = selectNativeMessageAttachments(
          { providerId: recipientProviderId ?? 'unknown', isLeadRecipient },
          validatedAttachments
        );
        const videoRestriction = await getNativeAttachmentRecipientRestriction({
          teamName: tn,
          memberName,
          providerId: recipientProviderId,
          attachments: nativeAttachments,
          resolveOpenCodeInputDeclaration: deps.getInputDeclarationResolver(),
          readTeamData: (teamName) =>
            getTeamDataService().getTeamData(teamName, { includeMemberBranches: false }),
        });
        if (videoRestriction) {
          throw new Error(videoRestriction);
        }
        const serializedResult = validateAgentAttachmentSerializedIpcPayload({
          text: payload.text!,
          attachments: validatedAttachments,
          nativeVideoDelivery:
            isOpenCodeRecipient &&
            nativeAttachments.some((attachment) => attachment.mimeType.startsWith('video/')),
        });
        if (!serializedResult.valid) throw new Error(serializedResult.error);
        const nativeIds = new Set(nativeAttachments.map((attachment) => attachment.id));
        const referenceBudget = validateAgentAttachmentSerializedIpcPayload({
          text: payload.text!,
          attachments: validatedAttachments.filter((attachment) => !nativeIds.has(attachment.id)),
        });
        if (!referenceBudget.valid) throw new Error(referenceBudget.error);
      }

      if (validatedAttachments?.length) {
        assertAttachmentRecipientOnline({
          isLeadRecipient,
          isAlive,
          isOpenCodeRecipient,
          providerId: recipientProviderId,
        });
      }

      // A live lead uses its owned runtime; only offline leads and members use the inbox.
      if (isLeadRecipient && isAlive && !isOpenCodeRecipient) {
        const resolvedLeadName = leadName ?? memberName;
        const teammateRoster = await getDurableLeadTeammateRoster(tn, resolvedLeadName);
        const rosterContextBlock = buildLeadRosterContextBlock(
          tn,
          resolvedLeadName,
          teammateRoster
        );
        const delegateAckBlock = buildLeadDirectDelegateAckBlock(actionMode);
        // Use one stable messageId for stdin and persistence provenance.
        const preGeneratedMessageId = validatedMessageId?.value ?? crypto.randomUUID();
        // Never redeliver an unknown runtime outcome through the inbox.
        const standaloneSlashCommand = !validatedAttachments?.length
          ? parseStandaloneSlashCommand(payload.text!)
          : null;
        const slashCommandMeta = standaloneSlashCommand
          ? buildStandaloneSlashCommandMeta(standaloneSlashCommand.raw)
          : null;
        const rawSlashCommandText = standaloneSlashCommand?.raw;
        const preparedAttachments = validatedAttachments?.length
          ? await prepareMessageAttachments(
              {
                teamName: tn,
                messageId: preGeneratedMessageId,
                text: payload.text!,
                from: payload.from,
                providerId: recipientProviderId ?? 'unknown',
                isLeadRecipient: true,
                attachments: validatedAttachments,
              },
              attachmentStore
            )
          : undefined;
        const stdinTextForLead = rawSlashCommandText
          ? rawSlashCommandText
          : [
              `You received a direct message from the user.`,
              buildDirectUserMessageReplyInstruction(),
              ...(rosterContextBlock ? [rosterContextBlock] : []),
              ...(delegateAckBlock ? [delegateAckBlock] : []),
              buildOriginalUserRequestBlock(preGeneratedMessageId),
              wrapAgentBlock(
                [
                  `MessageId: ${preGeneratedMessageId}`,
                  `When creating a task from this user message, prefer task_create_from_message with messageId="${preGeneratedMessageId}" for reliable provenance. Only use this exact messageId — never guess or fabricate one.`,
                ].join('\n')
              ),
              ``,
              `Message from user:`,
              buildMessageDeliveryText(preparedAttachments?.text ?? payload.text!, {
                actionMode,
                isLeadRecipient: true,
              }),
            ].join('\n');
        const persistTextForLead = rawSlashCommandText ?? payload.text!;

        try {
          await messaging.sendMessageToTeam(
            tn,
            stdinTextForLead,
            rawSlashCommandText ? undefined : preparedAttachments?.nativePayloads,
            rawSlashCommandText ? undefined : { userRequestMessageId: preGeneratedMessageId }
          );
        } catch (deliveryError: unknown) {
          if (validatedAttachments?.length) {
            throw new Error(
              formatAttachmentDeliveryFailure(deliveryError, runtime.isTeamAlive(tn))
            );
          }
          throw deliveryError;
        }

        const attachmentMeta = preparedAttachments?.stored;
        let result: SendMessageResult;
        try {
          result = await getTeamDataService().sendDirectToLead(
            tn,
            resolvedLeadName,
            persistTextForLead,
            payload.summary,
            attachmentMeta,
            validatedTaskRefs.value,
            preGeneratedMessageId,
            actionMode,
            preparedAttachments?.fileReferences
          );
        } catch (persistError) {
          logger.warn(
            `Persistence failed after runtime delivery for ${tn}: ${String(persistError)}`
          );
          result = { deliveredToInbox: false, messageId: preGeneratedMessageId };
        }

        messaging.pushLiveLeadProcessMessage(tn, {
          from: 'user',
          to: resolvedLeadName,
          text: persistTextForLead,
          timestamp: new Date().toISOString(),
          read: true,
          summary: payload.summary,
          messageId: result.messageId,
          source: 'user_sent',
          attachments: attachmentMeta,
          fileReferences: preparedAttachments?.fileReferences,
          taskRefs: validatedTaskRefs.value,
          ...(slashCommandMeta
            ? {
                messageKind: 'slash_command' as const,
                slashCommand: slashCommandMeta,
              }
            : {}),
        });

        return result;
      }

      // Inbox path: offline lead or regular members.
      const baseText = payload.text!.trim();
      const replyRecipient =
        typeof payload.from === 'string' && payload.from.trim().length > 0
          ? payload.from.trim()
          : 'user';
      const storedFrom = replyRecipient.toLowerCase() === 'user' ? 'user' : replyRecipient;
      const directReplyProtocol = resolveVisibleDirectReplyProtocol({
        isLeadRecipient,
        replyRecipient,
        ...(recipientProviderId ? { providerId: recipientProviderId } : {}),
      });
      const inboxMessageId = validatedMessageId?.value ?? crypto.randomUUID();
      const memberDeliveryText = buildMessageDeliveryText(baseText, {
        actionMode,
        isLeadRecipient,
        memberName,
        protocol: directReplyProtocol,
        replyRecipient,
        teamName: tn,
        ...(inboxMessageId ? { messageId: inboxMessageId } : {}),
      });
      const inboxText = isOpenCodeRecipient ? baseText : memberDeliveryText;
      const result = validatedAttachments?.length
        ? await admitNativeTeammateAttachmentIpcMessage(
            {
              teamName: tn,
              memberName,
              providerId: recipientProviderId,
              messageId: inboxMessageId,
              text: inboxText,
              summary: payload.summary,
              from: storedFrom,
              actionMode,
              taskRefs: validatedTaskRefs.value,
              attachments: validatedAttachments,
            },
            {
              readRuntimeSnapshot: (teamName) =>
                getTeamDiagnosticsApi().getTeamAgentRuntimeSnapshot(teamName),
              attachmentStore,
              runWithLiveRosterMutation: (teamName, operation) =>
                getTeamMemberLifecycleApi().runLiveRosterMutation(teamName, operation),
            }
          )
        : isOpenCodeRecipient
          ? await getTeamDataService().sendRuntimeRecipientMessage(tn, {
              member: memberName,
              text: inboxText,
              summary: payload.summary,
              from: storedFrom,
              actionMode,
              source: 'user_sent',
              taskRefs: validatedTaskRefs.value,
              messageId: inboxMessageId,
            })
          : await getTeamDataService().sendMessage(tn, {
              member: memberName,
              text: inboxText,
              summary: payload.summary,
              from: storedFrom,
              actionMode,
              source: 'user_sent',
              taskRefs: validatedTaskRefs.value,
              messageId: inboxMessageId,
            });

      // Native teammates consume their inbox directly. Keep member relay disabled.
      if (isOpenCodeRecipient) {
        try {
          const relay = await waitForOpenCodeRuntimeRelayForUi({
            messaging,
            teamName: tn,
            memberName,
            messageId: result.messageId,
            relayPromise: messaging.relayOpenCodeMemberInboxMessages(tn, memberName, {
              onlyMessageId: result.messageId,
              source: 'ui-send',
              deliveryMetadata: {
                replyRecipient,
                actionMode,
                taskRefs: validatedTaskRefs.value,
              },
            }),
          });
          const delivery = relay.lastDelivery ?? {
            delivered: relay.relayed > 0,
            reason: relay.relayed > 0 ? undefined : 'opencode_message_delivery_not_attempted',
            diagnostics: undefined,
          };
          result.runtimeDelivery = {
            providerId: 'opencode',
            attempted: true,
            delivered: delivery.delivered,
            accepted: delivery.accepted,
            responsePending: delivery.responsePending,
            acceptanceUnknown: delivery.acceptanceUnknown,
            responseState: delivery.responseState,
            ledgerStatus: delivery.ledgerStatus,
            visibleReplyMessageId: delivery.visibleReplyMessageId,
            visibleReplyCorrelation: delivery.visibleReplyCorrelation,
            ledgerRecordId: delivery.ledgerRecordId,
            laneId: delivery.laneId,
            queuedBehindMessageId: delivery.queuedBehindMessageId,
            reason: delivery.reason,
            diagnostics: delivery.diagnostics,
            userVisibleImpact:
              delivery.userVisibleImpact ?? buildOpenCodeRuntimeDeliveryUserVisibleImpact(delivery),
          };
          if (
            !delivery.delivered &&
            delivery.reason !== 'recipient_is_not_opencode' &&
            delivery.reason !== 'opencode_runtime_delivery_ui_timeout_pending'
          ) {
            logger.warn(
              `OpenCode runtime delivery after sendMessage failed for teammate "${memberName}": ${
                delivery.reason ?? 'unknown error'
              }`
            );
          }
        } catch (e: unknown) {
          const reason = e instanceof Error ? e.message : String(e);
          result.runtimeDelivery = {
            providerId: 'opencode',
            attempted: true,
            delivered: false,
            reason,
            diagnostics: [reason],
            userVisibleImpact: buildOpenCodeRuntimeDeliveryUserVisibleImpact({
              delivered: false,
              reason,
              diagnostics: [reason],
            }),
          };
          logger.warn(
            `OpenCode runtime delivery after sendMessage crashed for teammate "${memberName}": ${reason}`
          );
        }
      }

      // Best-effort relay for lead via inbox
      if (isLeadRecipient && isAlive) {
        void messaging
          .relayLeadInboxMessages(tn)
          .catch((e: unknown) =>
            logger.warn(`Relay after sendMessage failed for ${tn}: ${String(e)}`)
          );
      }

      return result;
    });
  }

  return handleSendMessage;
}
