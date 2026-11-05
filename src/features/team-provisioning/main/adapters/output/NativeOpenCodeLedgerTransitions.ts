import {
  buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan,
  buildOpenCodePromptLedgerFailedTerminalPlan,
  buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan,
  type OpenCodePromptDeliveryRequeuePlan,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

/**
 * Ledger moves that delivery performs without talking to a runtime.
 *
 * A delivery attempt ends in exactly three ways that are decided by the ledger
 * alone: it is declared terminally failed, it is re-queued because the previous
 * attempt produced no assistant response at all, or it is re-queued because the
 * runtime manifest watermark moved past it. All three are pure decisions plus
 * one ledger write, so they live here instead of inside the watchdog, and the
 * native delivery path can move its own records without the legacy service.
 */
export interface OpenCodeLedgerTransitionLogging {
  info(message: string, context?: string): void;
  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  /** The lead's turn ended; only the primary lane owns the lead's turn state. */
  notifyLeadTurnIdle?(record: OpenCodePromptDeliveryLedgerRecord): void;
}

export interface NativeOpenCodeLedgerTransitions {
  requeueNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  requeueRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
  markLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord>;
}

export function createNativeOpenCodeLedgerTransitions(input: {
  logging: OpenCodeLedgerTransitionLogging;
  nowIso(): string;
}): NativeOpenCodeLedgerTransitions {
  const requeue = async (
    plan: OpenCodePromptDeliveryRequeuePlan | null,
    ledger: OpenCodePromptDeliveryLedgerStore,
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord
  ): Promise<OpenCodePromptDeliveryLedgerRecord> => {
    if (!plan) {
      return ledgerRecord;
    }
    const requeued = await ledger.markNextAttemptScheduled(plan.markInput);
    input.logging.info(plan.logEvent, JSON.stringify(plan.logContext));
    return requeued;
  };

  return {
    async requeueNoAssistantTerminalDeliveryIfNeeded({ ledger, ledgerRecord }) {
      return requeue(
        buildOpenCodeNoAssistantTerminalDeliveryRequeuePlan({
          ledgerRecord,
          scheduledAt: input.nowIso(),
        }),
        ledger,
        ledgerRecord
      );
    },

    async requeueRuntimeManifestWatermarkDeliveryIfNeeded({ ledger, ledgerRecord }) {
      return requeue(
        buildOpenCodeRuntimeManifestWatermarkDeliveryRequeuePlan({
          ledgerRecord,
          scheduledAt: input.nowIso(),
        }),
        ledger,
        ledgerRecord
      );
    },

    async markLedgerFailedTerminal(failed) {
      const plan = buildOpenCodePromptLedgerFailedTerminalPlan({
        id: failed.id,
        reason: failed.reason,
        ...(failed.diagnostics ? { diagnostics: failed.diagnostics } : {}),
        failedAt: failed.failedAt,
        ...(failed.eventContext ? { eventContext: failed.eventContext } : {}),
      });
      const record = await failed.ledger.markFailedTerminal(plan.markInput);
      input.logging.logPromptDeliveryEvent('opencode_prompt_delivery_terminal_failure', record, {
        ...plan.eventExtra,
      });
      if (record.laneId === 'primary') {
        input.logging.notifyLeadTurnIdle?.(record);
      }
      return record;
    },
  };
}
