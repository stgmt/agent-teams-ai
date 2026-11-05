import { withFileLock } from '@main/services/team/fileLock';
import { atomicCreateAsync, atomicWriteAsync } from '@main/utils/atomicWrite';
import * as fs from 'fs';
import * as path from 'path';

import type { VerifiedAction } from '../../contracts';
import type {
  VerifiedActionStore,
  VerifiedActionTransaction,
} from '../application/VerifiedActionService';

/** Local queue entries are manifests, not publication to an external service. */
export class FileVerifiedActionStore implements VerifiedActionStore {
  private readonly statePath: string;
  private readonly queuePath: string;

  constructor(root: string) {
    this.statePath = path.join(root, 'actions.json');
    this.queuePath = path.join(root, 'queue');
  }

  async transaction<T>(fn: (tx: VerifiedActionTransaction) => Promise<T>): Promise<T> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    return withFileLock(
      this.statePath,
      () => fn({ read: () => this.read(), write: (actions) => this.write(actions) }),
      { preventLiveOwnerTakeover: true }
    );
  }

  async enqueue(action: VerifiedAction): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(action.id)) throw new Error('Invalid action id');
    const target = path.join(this.queuePath, `${action.id}.json`);
    const contents = `${JSON.stringify({
      version: 1,
      id: action.id,
      scope: action.scope,
      teamName: action.teamName,
      taskId: action.taskId,
      proof: action.proof,
    })}\n`;
    try {
      await atomicCreateAsync(target, contents, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A previously published matching manifest is a read, not another action.
      if ((await fs.promises.readFile(target, 'utf8')) !== contents) throw error;
    }
  }

  private async read(): Promise<VerifiedAction[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isStoredAction)) {
      throw new Error('Verified action state is invalid');
    }
    return parsed;
  }

  private async write(actions: VerifiedAction[]): Promise<void> {
    await atomicWriteAsync(this.statePath, `${JSON.stringify(actions)}\n`, {
      mode: 0o600,
      durability: 'strict',
      syncDirectory: true,
    });
  }
}

function isStoredAction(value: unknown): value is VerifiedAction {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const proof = item.proof as Record<string, unknown> | null;
  const decision = item.decisionReceipt as Record<string, unknown> | undefined;
  return (
    typeof item.id === 'string' &&
    /^[a-f0-9]{64}$/.test(item.id) &&
    typeof item.scope === 'string' &&
    typeof item.teamName === 'string' &&
    typeof item.taskId === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    ['awaiting_approval', 'running', 'question', 'manual', 'completed'].includes(
      String(item.status)
    ) &&
    [0, 1, 2].includes(item.attempts as number) &&
    (item.completion === undefined ||
      item.completion === 'queued' ||
      item.completion === 'user_attested') &&
    (decision === undefined ||
      (!!decision &&
        typeof decision === 'object' &&
        typeof decision.id === 'string' &&
        decision.id.length > 0 &&
        ['completed', 'retry_once', 'leave_unresolved'].includes(String(decision.decision)))) &&
    !!proof &&
    typeof proof === 'object' &&
    typeof proof.attachmentId === 'string' &&
    typeof proof.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(proof.sha256) &&
    Number.isSafeInteger(proof.size) &&
    (proof.size as number) >= 0
  );
}
