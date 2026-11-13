/**
 * Durable host-state persistence for the native Claude SDK transport: JSON
 * normalization of ledger payloads, idempotent command persistence, replay
 * reads, and fencing of attempts interrupted by an application restart.
 * All collaborators are injected; no store or transport state is held here.
 */

import {
  ApplicationCommandFailureKind,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';

import type { ApplicationCommandLedgerRecord } from '@features/application-command-ledger/contracts';
import type { ApplicationCommandRunner } from '@features/application-command-ledger/core/application/ApplicationCommandRunner';
import type { ApplicationCommandLedgerStore } from '@features/application-command-ledger/core/application/ports';
import type { ApplicationCommandJsonValue } from '@features/application-command-ledger/core/domain/stableJson';

export interface NativeSdkHostStateStoreDeps {
  runner: ApplicationCommandRunner;
  ledger: ApplicationCommandLedgerStore;
  namespace: string;
  /** Stable application storage/root identity, not the current application PID. */
  scopeKey: string;
}

export class NativeSdkHostStateStore {
  constructor(private readonly deps: NativeSdkHostStateStoreDeps) {}

  json(value: unknown): ApplicationCommandJsonValue {
    return JSON.parse(JSON.stringify(value)) as ApplicationCommandJsonValue;
  }

  async persist(
    id: string,
    payload: ApplicationCommandJsonValue,
    execute: () => Promise<ApplicationCommandJsonValue>
  ): Promise<ApplicationCommandJsonValue> {
    const result = await this.deps.runner.run(
      {
        namespace: this.deps.namespace,
        scopeKey: this.deps.scopeKey,
        commandId: id,
        idempotencyKey: id,
        operation: 'sdk-host-state',
        payload,
        metadata: payload,
        classifyError: () => ({ failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout }),
        reconcile: async () => ({ outcome: 'applied', result: payload }),
      },
      execute
    );
    return result.result;
  }

  async readResult(id: string): Promise<ApplicationCommandJsonValue> {
    const row = await this.deps.ledger.getByCommandId({
      namespace: this.deps.namespace,
      scopeKey: this.deps.scopeKey,
      commandId: id,
    });
    if (!row?.metadataJson)
      throw new Error('Native SDK persisted state is missing its durable value');
    const value = JSON.parse(row.metadataJson) as ApplicationCommandJsonValue;
    return this.persist(id, value, async () => value);
  }

  /** A newly constructed app host cannot own the previous host's in-flight ledger attempts. */
  async fenceInterrupted(rows: readonly ApplicationCommandLedgerRecord[]): Promise<void> {
    for (const row of rows) {
      if (row.status !== ApplicationCommandLedgerStatus.Started) continue;
      await this.deps.ledger.markFailed({
        namespace: row.namespace,
        scopeKey: row.scopeKey,
        commandId: row.commandId,
        attemptCount: row.attemptCount,
        failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
        errorMessage: 'Application SDK host restarted before outcome commit',
        completedAtIso: new Date().toISOString(),
      });
    }
  }
}
