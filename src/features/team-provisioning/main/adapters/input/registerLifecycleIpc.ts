import { randomUUID } from 'node:crypto';

import { createLogger } from '@shared/utils/logger';

import { TEAM_LIFECYCLE_CHANNELS } from '../../../contracts';

import type { TeamLifecycleFeed } from '../../../contracts';
import type { LifecycleQueries } from '../../../core/application/ports/LifecycleQueries';
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

const logger = createLogger('Feature:team-provisioning:lifecycleIpc');
const MAX_SUBSCRIPTIONS_PER_DOCUMENT = 32;

interface Subscription {
  id: string;
  feed: TeamLifecycleFeed | null;
  closed: boolean;
  reading: boolean;
}

interface DocumentOwner {
  subscriptions: Map<string, Subscription>;
  closed: boolean;
  detach(): void;
}

/** Pull IPC leaves backpressure in the registry's single latest-value slot. */
export function registerLifecycleIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  queries: LifecycleQueries,
  getMainContents: () => WebContents | null
): () => Promise<void> {
  const owners = new Map<WebContents, DocumentOwner>();
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  const closeEntry = async (owner: DocumentOwner, entry: Subscription): Promise<void> => {
    if (entry.closed) return;
    entry.closed = true;
    owner.subscriptions.delete(entry.id);
    await entry.feed?.return();
    if (!owner.subscriptions.size) owner.detach();
  };
  const closeOwner = async (owner: DocumentOwner): Promise<void> => {
    owner.closed = true;
    owner.detach();
    await Promise.all([...owner.subscriptions.values()].map((entry) => closeEntry(owner, entry)));
  };
  const trusted = (event: IpcMainInvokeEvent): WebContents => {
    const sender = event.sender;
    if (
      disposed ||
      sender !== getMainContents() ||
      sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== sender.mainFrame
    )
      throw new Error('Lifecycle access requires the current main renderer');
    return sender;
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation)
    );
    return operation;
  };
  const ownerFor = (sender: WebContents): DocumentOwner => {
    const existing = owners.get(sender);
    if (existing) return existing;
    const close = (): void => {
      void track(closeOwner(owner)).catch((error: unknown) =>
        logger.warn('Could not release a lifecycle subscription', error)
      );
    };
    const navigate = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) close();
    };
    const owner: DocumentOwner = {
      subscriptions: new Map(),
      closed: false,
      detach() {
        if (owners.get(sender) === owner) owners.delete(sender);
        sender.removeListener('destroyed', close);
        sender.removeListener('render-process-gone', close);
        sender.removeListener('did-start-navigation', navigate);
      },
    };
    owners.set(sender, owner);
    sender.once('destroyed', close);
    sender.once('render-process-gone', close);
    sender.on('did-start-navigation', navigate);
    return owner;
  };
  const lookup = (
    event: IpcMainInvokeEvent,
    input: unknown
  ): { owner: DocumentOwner; entry: Subscription; feed: TeamLifecycleFeed } => {
    const sender = trusted(event);
    const owner = owners.get(sender);
    const entry =
      typeof input === 'string' && input.length <= 128
        ? owner?.subscriptions.get(input)
        : undefined;
    if (!owner || !entry || entry.closed || !entry.feed)
      throw new Error('Lifecycle subscription is unavailable for this document');
    return { owner, entry, feed: entry.feed };
  };

  ipc.handle(TEAM_LIFECYCLE_CHANNELS.snapshot, (event, input: unknown) => {
    trusted(event);
    return queries.snapshot(input);
  });
  ipc.handle(TEAM_LIFECYCLE_CHANNELS.subscribe, (event, input: unknown) =>
    track(
      (async () => {
        const owner = ownerFor(trusted(event));
        if (owner.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_DOCUMENT)
          throw new Error('Lifecycle subscription limit reached');
        const entry: Subscription = { id: randomUUID(), feed: null, closed: false, reading: false };
        owner.subscriptions.set(entry.id, entry);
        try {
          entry.feed = await queries.watch(input);
          if (entry.closed || owner.closed || disposed) {
            await entry.feed.return();
            throw new Error('Lifecycle subscription document was closed');
          }
          return entry.id;
        } catch (error) {
          await closeEntry(owner, entry);
          throw error;
        }
      })()
    )
  );
  ipc.handle(TEAM_LIFECYCLE_CHANNELS.next, async (event, input: unknown) => {
    const { owner, entry, feed } = lookup(event, input);
    if (entry.reading) throw new Error('Lifecycle subscription already has a pending read');
    entry.reading = true;
    try {
      const result = await feed.next();
      if (result.done) await closeEntry(owner, entry);
      return result;
    } catch (error) {
      await closeEntry(owner, entry);
      throw error;
    } finally {
      entry.reading = false;
    }
  });
  ipc.handle(TEAM_LIFECYCLE_CHANNELS.close, async (event, input: unknown) => {
    const { owner, entry } = lookup(event, input);
    await closeEntry(owner, entry);
  });
  return async () => {
    if (!disposed) {
      disposed = true;
      for (const channel of Object.values(TEAM_LIFECYCLE_CHANNELS)) ipc.removeHandler(channel);
      await Promise.all([...owners.values()].map(closeOwner));
    }
    await Promise.allSettled([...pending]);
  };
}
