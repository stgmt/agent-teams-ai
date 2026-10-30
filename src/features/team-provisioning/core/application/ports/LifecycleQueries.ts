import type { TeamLifecycleFeed, TeamLifecycleSnapshot } from '../../../contracts';

export interface LifecycleQueries {
  snapshot(input: unknown): Promise<Readonly<TeamLifecycleSnapshot> | null>;
  watch(input: unknown): Promise<TeamLifecycleFeed>;
  aliveTeamNames(): Promise<readonly string[]>;
  aliveRunId(input: unknown): Promise<string | null>;
}
