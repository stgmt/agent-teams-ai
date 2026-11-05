import { getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAgendaSyncRecovery';
import {
  getOpenCodeMemberDeliveryBusyStatus,
  tryGetActiveOpenCodePromptDeliveryRecord,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeDelivery';

import type { NativeOpenCodeMemberIdentity } from './NativeOpenCodeMemberIdentity';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type {
  OpenCodeMemberDeliveryBusyStatus,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeDelivery';
import type { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import type { TaskRef } from '@shared/types';

export interface OpenCodeMemberDeliveryBusyInput {
  teamName: string;
  memberName: string;
  nowIso: string;
  workSyncIntent?: 'agenda_sync' | 'review_pickup';
  workSyncIntentKey?: string;
  taskRefs?: TaskRef[];
}

/**
 * Whether a member is mid-work, so a second prompt would interrupt it.
 *
 * Calling a busy member idle sends two prompts at once, which the lane answers by
 * interleaving them; calling a free member busy stalls work that could proceed.
 * Both are delivery defects, so the answer is read from the same evidence the lane
 * uses: lane state, unread foreground mail, and the ledger record that says a
 * prompt is still in flight.
 */
export interface NativeOpenCodeDeliveryBusyStatusDependencies {
  teamsBasePath: string;
  identity: Pick<
    NativeOpenCodeMemberIdentity,
    'isOpenCodeRuntimeRecipient' | 'resolveOpenCodeMemberDeliveryIdentity'
  >;
  inbox: Pick<TeamInboxReader, 'getMessagesFor'>;
  /** Recovers a lane from disk evidence; the runtime owns starting it. */
  recoverLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  recoverLaneAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean>;
  createLedger(teamName: string, laneId: string): OpenCodePromptDeliveryLedgerStore;
  scheduleWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void;
}

export class NativeOpenCodeDeliveryBusyStatus {
  constructor(private readonly deps: NativeOpenCodeDeliveryBusyStatusDependencies) {}

  async getBusyStatus(
    input: OpenCodeMemberDeliveryBusyInput
  ): Promise<OpenCodeMemberDeliveryBusyStatus> {
    return getOpenCodeMemberDeliveryBusyStatus(input, {
      teamsBasePath: this.deps.teamsBasePath,
      isOpenCodeRuntimeRecipient: (teamName, memberName) =>
        this.deps.identity.isOpenCodeRuntimeRecipient(teamName, memberName),
      inboxReader: this.deps.inbox,
      getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
        getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService(bypassInput, {
          resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
            this.deps.identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
          tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (verifyInput) =>
            this.deps.recoverLaneAndVerifyActive(verifyInput),
          createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
            this.deps.createLedger(teamName, laneId),
        }),
      tryGetActiveOpenCodePromptDeliveryRecord: (recordInput) =>
        this.readActiveRecord(recordInput),
      scheduleOpenCodeMemberInboxDeliveryWake: (wakeInput) => this.deps.scheduleWake(wakeInput),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.deps.identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: (recoverInput) =>
        this.deps.recoverLaneForConfiguredMemberBeforeDelivery(recoverInput),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (verifyInput) =>
        this.deps.recoverLaneAndVerifyActive(verifyInput),
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.deps.createLedger(teamName, laneId),
    });
  }

  private readActiveRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    return tryGetActiveOpenCodePromptDeliveryRecord(input, {
      teamsBasePath: this.deps.teamsBasePath,
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.deps.identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (verifyInput) =>
        this.deps.recoverLaneAndVerifyActive(verifyInput),
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.deps.createLedger(teamName, laneId),
    });
  }
}
