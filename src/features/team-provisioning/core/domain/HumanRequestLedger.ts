import type { TeamRunIdentity } from '../../contracts';

export function leadRequestRunKey(run: Readonly<TeamRunIdentity>): string {
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
  ]);
}

/**
 * One in-memory identity/active-slot store for human requests. Phase-specific adapters keep
 * their own transport/report fields, but cap, keying and the active-turn slot have one owner.
 */
export class HumanRequestLedger<
  T extends {
    readonly run: Readonly<TeamRunIdentity>;
    readonly requestMessageId: string;
  },
> {
  private readonly entries = new Map<string, T>();
  private readonly active = new Map<string, T>();

  constructor(private readonly capacity = 200) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('A positive request ledger capacity is required');
  }

  get(run: Readonly<TeamRunIdentity>, requestMessageId: string): T | undefined {
    return this.entries.get(this.key(run, requestMessageId));
  }

  current(run: Readonly<TeamRunIdentity>): T | undefined {
    return this.active.get(leadRequestRunKey(run));
  }

  register(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string,
    create: () => T,
    evictable: (value: T) => boolean
  ): T {
    if (this.entries.size >= this.capacity) {
      const completed = [...this.entries].find(([, value]) => evictable(value));
      if (!completed) throw new Error('Human request tracking capacity is exhausted');
      this.entries.delete(completed[0]);
      this.deactivate(completed[1].run, completed[1]);
    }
    const value = create();
    this.entries.set(this.key(run, requestMessageId), value);
    return value;
  }

  activate(run: Readonly<TeamRunIdentity>, value: T): void {
    this.active.set(leadRequestRunKey(run), value);
  }

  deactivate(run: Readonly<TeamRunIdentity>, value?: T): void {
    const scope = leadRequestRunKey(run);
    if (!value || this.active.get(scope) === value) this.active.delete(scope);
  }

  delete(run: Readonly<TeamRunIdentity>, requestMessageId: string, value?: T): void {
    this.entries.delete(this.key(run, requestMessageId));
    this.deactivate(run, value);
  }

  size(): number {
    return this.entries.size;
  }

  private key(run: Readonly<TeamRunIdentity>, requestMessageId: string): string {
    return JSON.stringify([leadRequestRunKey(run), requestMessageId]);
  }
}
