import { TeamOperationQueue } from '../../core/application/TeamOperationQueue';

/** Counts queued and executing team operations, including work outside the short lifecycle gate. */
export class NativeTeamOperationActivity {
  private readonly counts = new Map<string, number>();

  has(teamName: string): boolean {
    return (this.counts.get(teamName.trim().toLowerCase()) ?? 0) > 0;
  }

  run<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const key = teamName.trim().toLowerCase();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        const count = this.counts.get(key)! - 1;
        if (count === 0) this.counts.delete(key);
        else this.counts.set(key, count);
      });
  }
}

export class ObservedTeamOperationQueue extends TeamOperationQueue {
  constructor(private readonly activity: NativeTeamOperationActivity) {
    super();
  }

  override run<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.activity.run(teamName, () => super.run(teamName, operation));
  }
}
