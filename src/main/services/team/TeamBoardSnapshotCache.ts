/**
 * Short-lived board snapshot cache with single-flight loading.
 *
 * Concurrent callers share a pending load regardless of its duration. The TTL
 * starts after success, so slow loads cannot fan out into duplicate requests.
 */
export class TeamBoardSnapshotCache<T> {
  readonly #entries = new Map<string, { at: number | null; value: Promise<T> }>();

  constructor(
    private readonly ttlMs: number = 1000,
    private readonly now: () => number = () => Date.now()
  ) {}

  get(teamName: string, load: () => Promise<T>): Promise<T> {
    const hit = this.#entries.get(teamName);
    if (hit && (hit.at === null || this.now() - hit.at < this.ttlMs)) return hit.value;
    const value = load();
    const entry = { at: null as number | null, value };
    this.#entries.set(teamName, entry);
    void value.then(
      () => {
        entry.at = this.now();
      },
      () => {
        if (this.#entries.get(teamName) === entry) this.#entries.delete(teamName);
      }
    );
    return value;
  }

  invalidate(teamName: string): void {
    this.#entries.delete(teamName);
  }

  clear(): void {
    this.#entries.clear();
  }
}
