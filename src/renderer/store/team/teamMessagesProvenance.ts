import {
  type QueuedMessagesHeadRead,
  queueMessagesHeadRead,
  readTeamMessagesPage,
  type ScopedReadRequests,
} from '@features/team-read-recovery/renderer';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';

import {
  areInboxMessageArraysEquivalent,
  getTeamMessagesCacheEntry,
  pruneOptimisticMessages,
} from './teamMessagesCache';
import { carryOverLoadedPages } from './teamMessagesHistoryCarryOver';

import type { TeamSlice } from '../slices/teamSlice';
import type { AppState } from '../types';
import type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
  TeamMessagesRequestScope,
} from './teamMessagesCache';
import type { StateCreator } from 'zustand';

type MessageActions = Pick<TeamSlice, 'refreshTeamMessagesHead' | 'loadOlderTeamMessages'>;
interface MessageActionPorts {
  set: Parameters<StateCreator<AppState>>[0];
  get: () => AppState;
  captureTeamRequestScope: (get: () => AppState, teamName: string) => TeamMessagesRequestScope;
  isTeamRequestScopeCurrent: (
    get: () => AppState,
    teamName: string,
    scope: TeamMessagesRequestScope
  ) => boolean;
  inFlightTeamMessagesHeadRequests: ScopedReadRequests<RefreshTeamMessagesHeadResult>;
  inFlightTeamMessagesOlderRequests: ScopedReadRequests<void>;
  queuedTeamMessagesHeadRefreshesAfterOlder: Map<
    string,
    QueuedMessagesHeadRead & { scope: TeamMessagesRequestScope }
  >;
}

/** Paging is fire-and-forget in the UI; expected head IPC failures already have a scoped notice. */
async function observeHeadForPaging(
  request: Promise<RefreshTeamMessagesHeadResult>
): Promise<boolean> {
  try {
    await request;
    return true;
  } catch (error) {
    if (error instanceof IpcError) return false;
    throw error;
  }
}

/** Head and explicitly requested history share the existing incarnation-scoped single-flight. */
export function createTeamMessagesProvenanceActions(ports: MessageActionPorts): MessageActions {
  const {
    set,
    get,
    captureTeamRequestScope,
    isTeamRequestScopeCurrent,
    inFlightTeamMessagesHeadRequests,
    inFlightTeamMessagesOlderRequests,
    queuedTeamMessagesHeadRefreshesAfterOlder,
  } = ports;
  const hasCurrentProvenance = (teamName: string, entry: TeamMessagesCacheEntry): boolean => {
    // Legacy entries have no page claims; their canonical array is treated as one head.
    if (!entry.provenance) return true;
    return (
      isTeamRequestScopeCurrent(get, teamName, entry.provenance.requestScope) &&
      entry.provenance.pages.every(
        (page) =>
          page.sourceRevision === entry.feedRevision &&
          isTeamRequestScopeCurrent(get, teamName, page.requestScope)
      )
    );
  };
  return {
    refreshTeamMessagesHead: async (teamName: string) => {
      const requestScope = captureTeamRequestScope(get, teamName);
      const existingRequest = inFlightTeamMessagesHeadRequests.get(teamName, requestScope);
      if (existingRequest) {
        return inFlightTeamMessagesHeadRequests.queueFresh(
          teamName,
          requestScope,
          () => get().refreshTeamMessagesHead(teamName),
          () => isTeamRequestScopeCurrent(get, teamName, requestScope)
        );
      }
      const queuedAfterOlder = queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName);
      if (queuedAfterOlder) {
        if (isTeamRequestScopeCurrent(get, teamName, queuedAfterOlder.scope))
          return queuedAfterOlder.result;
        queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
        queuedAfterOlder.cancel();
      }

      const existingOlderRequest = inFlightTeamMessagesOlderRequests.get(teamName, requestScope);
      if (existingOlderRequest) {
        const queuedRequest = {
          scope: requestScope,
          ...queueMessagesHeadRead(
            existingOlderRequest,
            () => {
              if (
                !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
                queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) !== queuedRequest
              ) {
                return Promise.resolve({
                  feedChanged: false,
                  headChanged: false,
                  feedRevision: null,
                });
              }
              queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
              return get().refreshTeamMessagesHead(teamName);
            },
            () => {
              if (queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) === queuedRequest) {
                queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
              }
            }
          ),
        };
        queuedTeamMessagesHeadRefreshesAfterOlder.set(teamName, queuedRequest);
        return queuedRequest.result;
      }

      const requestRef: { current: Promise<RefreshTeamMessagesHeadResult> | null } = {
        current: null,
      };
      requestRef.current = (async (): Promise<RefreshTeamMessagesHeadResult> => {
        const startingRevision = getTeamMessagesCacheEntry(get(), teamName).feedRevision;
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingHead: true,
            },
          },
        }));

        try {
          const page = await unwrapIpc('team:getMessagesPage', () =>
            readTeamMessagesPage(teamName, { limit: 50 })
          );
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesHeadRequests.get(teamName, requestScope) !== requestRef.current
          ) {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }

          const previousEntry = getTeamMessagesCacheEntry(get(), teamName);
          if (previousEntry.feedRevision !== startingRevision) {
            set((state) => ({
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: { ...getTeamMessagesCacheEntry(state, teamName), loadingHead: false },
              },
            }));
            return { feedChanged: false, headChanged: false, feedRevision: null };
          }
          const feedChanged =
            !previousEntry.headHydrated || previousEntry.feedRevision !== page.feedRevision;
          const previousHeadSlice =
            previousEntry.provenance?.head ?? previousEntry.canonicalMessages;
          const headChanged = !areInboxMessageArraysEquivalent(previousHeadSlice, page.messages);

          set((state) => {
            const current = getTeamMessagesCacheEntry(state, teamName);
            // Revisions hash all sources, so a new message changes them. Loaded history stays
            // only while the new head still joins it (see carryOverLoadedPages).
            const oldPages = current.provenance?.pages ?? [];
            const scopeIntact =
              hasCurrentProvenance(teamName, current) &&
              oldPages.every(
                (loaded) =>
                  loaded.requestScope.contextId === requestScope.contextId &&
                  loaded.requestScope.contextEpoch === requestScope.contextEpoch &&
                  loaded.requestScope.teamStateEpoch === requestScope.teamStateEpoch
              );
            const pages = !scopeIntact
              ? []
              : current.feedRevision === page.feedRevision &&
                  page.nextCursor === oldPages[0]?.inputCursor
                ? oldPages
                : (carryOverLoadedPages({
                    previousHead: current.provenance?.head ?? current.canonicalMessages,
                    previousPages: oldPages,
                    head: page,
                    feedRevision: page.feedRevision,
                  }) ?? []);
            const historyReloadRequired = oldPages.length > 0 && pages.length === 0;
            const projected =
              pages.length > 0
                ? mergeTeamMessages(...pages.map((loaded) => loaded.messages), page.messages)
                : page.messages;
            const nextCanonical = areInboxMessageArraysEquivalent(
              current.canonicalMessages,
              projected
            )
              ? current.canonicalMessages
              : projected;
            const historyError = historyReloadRequired
              ? page.hasMore
                ? 'Message history changed. Load older messages again to refresh it.'
                : 'Message history changed. Showing the current history.'
              : current.historyReloadRequired
                ? current.messagesError
                : null;
            const nextOptimistic = pruneOptimisticMessages(
              current.optimisticMessages,
              nextCanonical
            );
            const nextEntry: TeamMessagesCacheEntry = {
              ...current,
              provenance: { head: page.messages, pages, requestScope },
              historyReloadRequired:
                (historyReloadRequired || current.historyReloadRequired) && page.hasMore,
              messagesError: historyError,
              canonicalMessages: nextCanonical,
              optimisticMessages: nextOptimistic,
              feedRevision: page.feedRevision,
              nextCursor: pages.length > 0 ? current.nextCursor : page.nextCursor,
              hasMore: pages.length > 0 ? current.hasMore : page.hasMore,
              lastFetchedAt: Date.now(),
              loadingHead: false,
              headHydrated: true,
            };
            return {
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: nextEntry,
              },
            };
          });

          return {
            feedChanged,
            headChanged,
            feedRevision: page.feedRevision,
          };
        } catch (error) {
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesHeadRequests.get(teamName, requestScope) !== requestRef.current
          ) {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }
          const revisionIsCurrent =
            getTeamMessagesCacheEntry(get(), teamName).feedRevision === startingRevision;
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingHead: false,
                messagesError: revisionIsCurrent
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : getTeamMessagesCacheEntry(state, teamName).messagesError,
              },
            },
          }));
          if (!revisionIsCurrent)
            return { feedChanged: false, headChanged: false, feedRevision: null };
          throw error;
        } finally {
          inFlightTeamMessagesHeadRequests.release(teamName, requestRef.current);
        }
      })();

      const request = requestRef.current;
      inFlightTeamMessagesHeadRequests.set(teamName, request, requestScope);
      return request;
    },

    loadOlderTeamMessages: async (teamName: string) => {
      const requestedScope = captureTeamRequestScope(get, teamName);
      const existingRequest = inFlightTeamMessagesOlderRequests.get(teamName, requestedScope);
      if (existingRequest) {
        return existingRequest;
      }

      const existingHeadRequest = inFlightTeamMessagesHeadRequests.get(teamName, requestedScope);
      if (existingHeadRequest) {
        if (!(await observeHeadForPaging(existingHeadRequest))) return;
        if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
          return;
        }
      }

      let entry = getTeamMessagesCacheEntry(get(), teamName);
      if (!entry.headHydrated || !hasCurrentProvenance(teamName, entry)) {
        if (!(await observeHeadForPaging(get().refreshTeamMessagesHead(teamName)))) return;
        if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
          return;
        }
        entry = getTeamMessagesCacheEntry(get(), teamName);
      }

      if (
        !entry.headHydrated ||
        !hasCurrentProvenance(teamName, entry) ||
        !entry.nextCursor ||
        entry.loadingOlder ||
        entry.loadingHead
      ) {
        return;
      }

      const inputCursor = entry.nextCursor;
      const requestRef: { current: Promise<void> | null } = { current: null };
      requestRef.current = (async (): Promise<void> => {
        const requestScope = captureTeamRequestScope(get, teamName);
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingOlder: true,
            },
          },
        }));

        try {
          const baseFeedRevision = entry.feedRevision;
          const page = await unwrapIpc('team:getMessagesPage', () =>
            readTeamMessagesPage(teamName, {
              cursor: inputCursor,
              limit: 50,
            })
          );
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesOlderRequests.get(teamName, requestScope) !== requestRef.current
          ) {
            return;
          }

          const current = getTeamMessagesCacheEntry(get(), teamName);
          const feedMoved =
            current.feedRevision !== baseFeedRevision ||
            (current.feedRevision && current.feedRevision !== page.feedRevision);
          // New messages at the head do not touch older history: a page read while the feed
          // moved is kept as long as the loaded history still ends at its input cursor.
          const joinsLoadedHistory =
            current.nextCursor === inputCursor && hasCurrentProvenance(teamName, current);
          if (feedMoved && !joinsLoadedHistory) {
            set((state) => ({
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...getTeamMessagesCacheEntry(state, teamName),
                  loadingOlder: false,
                  historyReloadRequired: true,
                  messagesError:
                    'Message history changed. Load older messages again to refresh it.',
                },
              },
            }));
            // Release the older owner before starting its queued head; neither may
            // await a head that is still waiting for this older request to settle.
            inFlightTeamMessagesOlderRequests.release(teamName, requestRef.current);
            const queuedHead = queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName);
            await observeHeadForPaging(
              queuedHead && isTeamRequestScopeCurrent(get, teamName, queuedHead.scope)
                ? queuedHead.start()
                : get().refreshTeamMessagesHead(teamName)
            );
            return;
          }

          set((state) => {
            const liveEntry = getTeamMessagesCacheEntry(state, teamName);
            const head = liveEntry.provenance?.head ?? liveEntry.canonicalMessages;
            const pages = [
              ...(liveEntry.provenance?.pages ?? []),
              {
                messages: page.messages,
                inputCursor,
                outputCursor: page.nextCursor,
                hasMore: page.hasMore,
                sourceRevision: liveEntry.feedRevision ?? page.feedRevision,
                requestScope,
              },
            ];
            const mergedCanonical = mergeTeamMessages(
              ...pages.map((loaded) => loaded.messages),
              head
            );
            return {
              teamMessagesByName: {
                ...state.teamMessagesByName,
                [teamName]: {
                  ...liveEntry,
                  provenance: { head, pages, requestScope },
                  canonicalMessages: mergedCanonical,
                  optimisticMessages: pruneOptimisticMessages(
                    liveEntry.optimisticMessages,
                    mergedCanonical
                  ),
                  historyReloadRequired: false,
                  messagesError: null,
                  nextCursor: page.nextCursor,
                  hasMore: page.hasMore,
                  feedRevision: liveEntry.feedRevision ?? page.feedRevision,
                  loadingOlder: false,
                },
              },
            };
          });
          if (feedMoved) {
            // The head is stale: refresh it the same way as after a dropped page.
            inFlightTeamMessagesOlderRequests.release(teamName, requestRef.current);
            const queuedHead = queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName);
            await observeHeadForPaging(
              queuedHead && isTeamRequestScopeCurrent(get, teamName, queuedHead.scope)
                ? queuedHead.start()
                : get().refreshTeamMessagesHead(teamName)
            );
          }
        } catch (error) {
          if (
            !isTeamRequestScopeCurrent(get, teamName, requestScope) ||
            inFlightTeamMessagesOlderRequests.get(teamName, requestScope) !== requestRef.current
          ) {
            return;
          }
          const revisionIsCurrent =
            getTeamMessagesCacheEntry(get(), teamName).feedRevision === entry.feedRevision;
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingOlder: false,
                historyReloadRequired:
                  revisionIsCurrent ||
                  getTeamMessagesCacheEntry(state, teamName).historyReloadRequired,
                messagesError: revisionIsCurrent
                  ? error instanceof Error
                    ? error.message
                    : String(error)
                  : getTeamMessagesCacheEntry(state, teamName).messagesError,
              },
            },
          }));
        } finally {
          inFlightTeamMessagesOlderRequests.release(teamName, requestRef.current);
        }
      })();

      const request = requestRef.current;
      inFlightTeamMessagesOlderRequests.set(teamName, request, requestedScope);
      return request;
    },
  };
}
