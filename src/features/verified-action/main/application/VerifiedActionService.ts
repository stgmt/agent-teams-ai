import { createHash, randomUUID } from 'crypto';

import type { VerifiedAction, VerifiedActionDecision, VerifiedActionProof } from '../../contracts';

export interface VerifiedActionTransaction {
  read(): Promise<VerifiedAction[]>;
  write(actions: VerifiedAction[]): Promise<void>;
}

export interface VerifiedActionStore {
  transaction<T>(fn: (tx: VerifiedActionTransaction) => Promise<T>): Promise<T>;
}

export interface VerifiedActionServiceOptions {
  store: VerifiedActionStore;
  verify(scope: string, teamName: string, taskId: string): Promise<VerifiedActionProof | null>;
  enqueue(action: VerifiedAction): Promise<void>;
  now?: () => string;
}

/**
 * One persistent decision belongs to one payload. A running record left by a
 * crashed process is uncertain; reading it never repeats the side effect.
 * The store holds its lock until the effect and its status write have settled.
 */
export class VerifiedActionService {
  private readonly now: () => string;

  constructor(private readonly options: VerifiedActionServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async list(scope: string, teamName: string, taskId: string): Promise<VerifiedAction[]> {
    return this.options.store.transaction(async (tx) => {
      const actions = await tx.read();
      let changed = false;
      for (const action of actions) {
        if (
          action.scope === scope &&
          action.teamName === teamName &&
          action.taskId === taskId &&
          action.status === 'running'
        ) {
          action.status = action.attempts === 1 && !action.decisionReceipt ? 'question' : 'manual';
          action.updatedAt = this.now();
          changed = true;
        }
      }
      if (changed) await tx.write(actions);
      return actions.filter(
        (action) =>
          action.scope === scope && action.teamName === teamName && action.taskId === taskId
      );
    });
  }

  async prepare(scope: string, teamName: string, taskId: string): Promise<VerifiedAction> {
    return this.options.store.transaction(async (tx) => {
      const proof = await this.requireProof(scope, teamName, taskId);
      const id = createHash('sha256')
        .update(
          JSON.stringify([scope, teamName, taskId, proof.attachmentId, proof.sha256, proof.size])
        )
        .digest('hex');
      const actions = await tx.read();
      const existing = actions.find((action) => action.id === id);
      if (existing) return existing;
      const timestamp = this.now();
      const action: VerifiedAction = {
        id,
        scope,
        teamName,
        taskId,
        proof,
        status: 'awaiting_approval',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      actions.push(action);
      await tx.write(actions);
      return action;
    });
  }

  async approve(scope: string, id: string): Promise<VerifiedAction> {
    return this.options.store.transaction(async (tx) => {
      const actions = await tx.read();
      const action = this.get(actions, scope, id);
      if (action.status !== 'awaiting_approval') return action;
      await this.assertProof(action);
      return this.execute(tx, actions, action, 1);
    });
  }

  async decide(
    scope: string,
    id: string,
    decision: VerifiedActionDecision,
    decisionId: string = randomUUID()
  ): Promise<VerifiedAction> {
    return this.options.store.transaction(async (tx) => {
      const actions = await tx.read();
      const action = this.get(actions, scope, id);
      if (action.decisionReceipt) {
        if (
          action.decisionReceipt.id === decisionId &&
          action.decisionReceipt.decision === decision
        )
          return action;
        throw new Error('This action has no pending question');
      }
      if (action.status !== 'question') throw new Error('This action has no pending question');
      action.decisionReceipt = { id: decisionId, decision };
      if (decision === 'completed') {
        action.status = 'completed';
        action.completion = 'user_attested';
      } else if (decision === 'leave_unresolved') {
        action.status = 'manual';
      } else if (decision === 'retry_once') {
        try {
          await this.assertProof(action);
        } catch {
          // The one decision is consumed even if verification now fails.
          // No second question or attempt is created for a changed artifact.
          action.status = 'manual';
          action.updatedAt = this.now();
          await tx.write(actions);
          return action;
        }
        return this.execute(tx, actions, action, 2);
      } else {
        throw new Error('Invalid action decision');
      }
      action.updatedAt = this.now();
      await tx.write(actions);
      return action;
    });
  }

  /**
   * Record a previously chosen answer without running the action. This fences
   * a delayed decide under the same lock, so recovery never resends the effect.
   */
  async fenceDecision(
    scope: string,
    id: string,
    decision: VerifiedActionDecision,
    decisionId: string
  ): Promise<VerifiedAction> {
    return this.options.store.transaction(async (tx) => {
      const actions = await tx.read();
      const action = this.get(actions, scope, id);
      const receipt = action.decisionReceipt;
      if (receipt && (receipt.id !== decisionId || receipt.decision !== decision)) {
        throw new Error('A different decision was already recorded');
      }
      if (!receipt && action.status !== 'question') {
        throw new Error('The decision cannot be reconciled');
      }
      if (!receipt) action.decisionReceipt = { id: decisionId, decision };
      if (!receipt || action.status === 'running') {
        if (decision === 'completed' && !receipt) {
          action.status = 'completed';
          action.completion = 'user_attested';
        } else {
          action.status = 'manual';
        }
        action.updatedAt = this.now();
        await tx.write(actions);
      }
      return action;
    });
  }

  private async execute(
    tx: VerifiedActionTransaction,
    actions: VerifiedAction[],
    action: VerifiedAction,
    attempt: 1 | 2
  ): Promise<VerifiedAction> {
    action.status = 'running';
    action.attempts = attempt;
    action.updatedAt = this.now();
    await tx.write(actions);
    try {
      // The status write can take time. Recheck after it, immediately before
      // publishing the manifest; later consumers still need to verify again.
      await this.assertProof(action);
    } catch {
      action.status = 'manual';
      action.updatedAt = this.now();
      await tx.write(actions);
      return action;
    }
    try {
      await this.options.enqueue(action);
      action.status = 'completed';
      action.completion = 'queued';
    } catch {
      // Failure may mean the effect happened but its response was lost.
      action.status = attempt === 1 ? 'question' : 'manual';
    }
    action.updatedAt = this.now();
    await tx.write(actions);
    return action;
  }

  private async assertProof(action: VerifiedAction): Promise<void> {
    const proof = await this.requireProof(action.scope, action.teamName, action.taskId);
    if (
      proof.attachmentId !== action.proof.attachmentId ||
      proof.sha256 !== action.proof.sha256 ||
      proof.size !== action.proof.size
    ) {
      throw new Error('The artifact changed after this action was prepared');
    }
  }

  private async requireProof(
    scope: string,
    teamName: string,
    taskId: string
  ): Promise<VerifiedActionProof> {
    const proof = await this.options.verify(scope, teamName, taskId);
    if (!proof) throw new Error('A verified task artifact is required');
    if (
      !proof.attachmentId ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !Number.isSafeInteger(proof.size) ||
      proof.size < 0
    ) {
      throw new Error('Invalid task artifact proof');
    }
    return proof;
  }

  private get(actions: VerifiedAction[], scope: string, id: string): VerifiedAction {
    const action = actions.find((item) => item.id === id && item.scope === scope);
    if (!action) throw new Error('Verified action not found');
    return action;
  }
}
