import type { TeamLifecycleFeed, TeamLifecycleQuery, TeamLifecycleReadApi } from '../contracts';

/** The iterator stays in the renderer; only ordinary values cross contextBridge. */
export async function watchTeamLifecycle(
  api: TeamLifecycleReadApi,
  request: TeamLifecycleQuery
): Promise<TeamLifecycleFeed> {
  const id = await api.openLifecycleSubscription(request);
  let closed = false;
  let reading = false;
  let closing: Promise<void> | null = null;
  const feed: TeamLifecycleFeed = {
    async next() {
      if (closed) return { done: true, value: undefined };
      if (reading) throw new Error('Lifecycle feed already has a pending read');
      reading = true;
      try {
        const result = await api.readLifecycleSubscription(id);
        if (closed || result.done) {
          closed = true;
          return { done: true, value: undefined };
        }
        return result;
      } catch (error) {
        // The main adapter also closes its subscription when a pull fails.
        closed = true;
        throw error;
      } finally {
        reading = false;
      }
    },
    async return() {
      if (!closed) {
        closed = true;
        closing = api.closeLifecycleSubscription(id);
      }
      await closing;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return feed;
    },
  };
  return feed;
}
