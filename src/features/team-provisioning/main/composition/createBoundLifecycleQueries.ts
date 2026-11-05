import { AppContextMismatchError } from '@features/external-agent-connection/main';

import { parseBoundLifecycleRequest } from '../infrastructure/parseBoundLifecycleRequest';

import type { TeamLifecycleFeed, TeamLifecycleSnapshot } from '../../contracts';
import type { LifecycleQueries } from '../../core/application/ports/LifecycleQueries';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

interface Dependencies {
  owner: Readonly<AppConnectionContext>;
  source: {
    findSnapshot(teamName: string): Readonly<TeamLifecycleSnapshot> | null;
    watch(teamName: string): TeamLifecycleFeed;
    aliveTeamNames(): readonly string[];
    aliveRunId(teamName: string): string | null;
  };
  invalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
}

/** Fence each delivered value, not the lifetime of an idle transport subscription. */
export function createBoundLifecycleQueries(deps: Dependencies): LifecycleQueries {
  const owner = Object.freeze({ ...deps.owner });
  const parse = (input: unknown): string => parseBoundLifecycleRequest(input, owner).teamName;
  const admitted = <T>(operation: () => T): Promise<T> =>
    deps.withExpectedContext(owner, async () => operation());

  return {
    snapshot: async (input) => {
      const teamName = parse(input);
      return admitted(() => deps.source.findSnapshot(teamName));
    },
    aliveTeamNames: async () => admitted(() => deps.source.aliveTeamNames()),
    aliveRunId: async (input) => {
      const teamName = parse(input);
      return admitted(() => deps.source.aliveRunId(teamName));
    },
    watch: async (input) => {
      const teamName = parse(input);
      const { source, invalidation } = await admitted(() => ({
        invalidation: deps.invalidationSignal(owner),
        source: deps.source.watch(teamName),
      }));
      let closed = false;
      let reading = false;
      let invalidated = invalidation.aborted;
      let returnSource: Promise<IteratorResult<Readonly<TeamLifecycleSnapshot>, undefined>> | null =
        null;
      const release = (): Promise<IteratorResult<Readonly<TeamLifecycleSnapshot>, undefined>> => {
        returnSource ??= source.return();
        return returnSource;
      };
      const revoke = (): void => {
        invalidated = true;
        invalidation.removeEventListener('abort', revoke);
        void release();
      };
      invalidation.addEventListener('abort', revoke, { once: true });
      if (invalidated) revoke();
      const feed: TeamLifecycleFeed = {
        async next() {
          if (closed) return { done: true, value: undefined };
          if (invalidated) {
            await feed.return();
            throw new AppContextMismatchError();
          }
          if (reading) throw new Error('Lifecycle feed already has a pending read');
          reading = true;
          try {
            await admitted(() => undefined);
            if (closed) return { done: true, value: undefined };
            const result = await source.next();
            if (invalidated) throw new AppContextMismatchError();
            if (closed) return { done: true, value: undefined };
            return await admitted(() => result);
          } catch (error) {
            await feed.return();
            throw error;
          } finally {
            reading = false;
          }
        },
        async return() {
          if (!closed) {
            closed = true;
            invalidation.removeEventListener('abort', revoke);
            await release();
          }
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return feed;
        },
      };
      return feed;
    },
  };
}
