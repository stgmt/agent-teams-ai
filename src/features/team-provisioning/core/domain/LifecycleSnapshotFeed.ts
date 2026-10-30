import type { TeamLifecycleFeed, TeamLifecycleSnapshot } from '../../contracts';

type Snapshot = Readonly<TeamLifecycleSnapshot>;
type Result = IteratorResult<Snapshot, undefined>;

/** One latest-value slot per consumer; slow transports cannot retain an unbounded event history. */
export class LifecycleSnapshotFeed implements TeamLifecycleFeed {
  private latest: Snapshot | null = null;
  private version = -1;
  private closed = false;
  private waiting: ((result: Result) => void) | null = null;

  constructor(private readonly detach: () => void) {}

  publish(snapshot: Snapshot): void {
    if (this.closed || snapshot.version <= this.version) return;
    this.version = snapshot.version;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = null;
      waiting({ done: false, value: snapshot });
    } else this.latest = snapshot;
  }

  next(): Promise<Result> {
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    if (this.latest) {
      const value = this.latest;
      this.latest = null;
      return Promise.resolve({ done: false, value });
    }
    if (this.waiting) return Promise.reject(new Error('Lifecycle feed already has a pending read'));
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  return(): Promise<Result> {
    if (!this.closed) {
      this.closed = true;
      this.latest = null;
      this.detach();
      this.waiting?.({ done: true, value: undefined });
      this.waiting = null;
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): TeamLifecycleFeed {
    return this;
  }
}
