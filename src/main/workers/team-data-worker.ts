/**
 * Worker thread for heavy team I/O operations (getTeamData, findLogsForTask).
 *
 * Runs in its own event loop, completely isolated from the Electron main thread.
 * This prevents file-heavy operations (scanning 300+ subagent JSONL files,
 * parsing large session files) from stalling the main process UI/IPC.
 *
 * Filesystem projections stay here; registry board reads use the existing private
 * parent channel. Only main owns registry authentication. Replies bypass the
 * heavy-read queue so an active projection can await MCP alongside filesystem I/O.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

import { RegistryTaskProviderError } from '@main/services/team/registry/RegistryTaskProvider';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { serializeRegistryBoardReadFailure } from '@main/services/team/teamDataWorkerTypes';
import { TeamMemberLogsFinder } from '@main/services/team/TeamMemberLogsFinder';
import { applyElectronDevClaudeRootOverrideForWorker } from '@main/utils/electronDevPathOverrides';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { RegistryBoardSnapshotReadPort } from '@main/services/team/registry/RegistryTaskProvider';
import type {
  RegistryBoardReadRequest,
  RegistryBoardReadResponse,
  TeamDataWorkerRequest,
  TeamDataWorkerResponse,
} from '@main/services/team/teamDataWorkerTypes';
import type { MemberLogSummary, TeamAgentRuntimeSnapshot, TeamTask } from '@shared/types';

const logger = createLogger('Worker:TeamData');

// Worker threads skip Electron startup. Mirror the explicit dev override first,
// then bind this instance to main's resolved root before creating any services.
applyElectronDevClaudeRootOverrideForWorker();
if (typeof workerData === 'string') {
  setClaudeBasePathOverride(workerData);
}

// Main supplies its authoritative native snapshot for each heavy read.
// Request-local scope keeps concurrent teams isolated without a second runtime owner.
const runtimeSnapshots = new AsyncLocalStorage<TeamAgentRuntimeSnapshot>();
const registryBoardReads = new Map<
  string,
  {
    resolve: (tasks: TeamTask[]) => void;
    reject: (error: Error) => void;
  }
>();
const boardSnapshots: RegistryBoardSnapshotReadPort = {
  readBoardSnapshot(teamName, options) {
    const port = parentPort;
    if (!port) {
      return Promise.reject(new Error('Registry board parent channel unavailable'));
    }
    const request: RegistryBoardReadRequest = {
      id: randomUUID(),
      op: 'readRegistryBoard',
      payload: { teamName, ...(options ? { options } : {}) },
    };
    return new Promise<TeamTask[]>((resolve, reject) => {
      registryBoardReads.set(request.id, { resolve, reject });
      try {
        port.postMessage(request);
      } catch (error) {
        registryBoardReads.delete(request.id);
        reject(error);
      }
    });
  },
};
const teamDataService = new TeamDataService(
  async (teamName) => {
    const snapshot = runtimeSnapshots.getStore();
    if (!snapshot || snapshot.teamName !== teamName) {
      throw new Error(`Native runtime snapshot unavailable for ${teamName}`);
    }
    return snapshot;
  },
  undefined, // configReader
  undefined, // inboxReader
  undefined, // inboxWriter
  undefined, // memberResolver
  undefined, // kanbanManager
  undefined, // membersMetaStore
  undefined, // sentMessagesStore
  undefined, // controllerFactory
  undefined, // taskCommentNotificationJournal
  undefined, // teamMetaStore
  undefined, // memberRuntimeAdvisoryService
  undefined, // leadSessionParseCache
  undefined, // projectResolver
  undefined, // launchStateStore
  undefined, // registryTaskWriterProvider
  undefined, // registryTaskProvider (lazy; never authenticated in worker)
  undefined, // executionTaskStore
  undefined, // taskAttachmentStore
  undefined, // taskSigningKeyStoreFactory
  undefined, // taskAttestationJournal
  boardSnapshots
);
const logsFinder = new TeamMemberLogsFinder();

// In-flight dedup: concurrent calls for the same task piggyback on one request
const logsInFlight = new Map<string, Promise<unknown>>();
// Result cache with TTL to avoid re-scanning files
const logsResultCache = new Map<string, { result: MemberLogSummary[]; cachedAt: number }>();
const LOGS_CACHE_TTL_MS = 10_000;
let heavyReadQueue: Promise<void> = Promise.resolve();

function respond(msg: TeamDataWorkerResponse): void {
  parentPort?.postMessage(msg);
}

function runHeavyRead<T>(load: () => Promise<T>): Promise<T> {
  const result = heavyReadQueue.catch(() => undefined).then(load);
  heavyReadQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

parentPort?.on('message', async (msg: TeamDataWorkerRequest | RegistryBoardReadResponse) => {
  // Registry replies must bypass the queue whose active read is awaiting them.
  if (msg.op === 'registryBoardResult') {
    const pending = registryBoardReads.get(msg.id);
    if (!pending) return;
    registryBoardReads.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.tasks);
    } else {
      pending.reject(new RegistryTaskProviderError(msg.failure));
    }
    return;
  }
  const startedAt = Date.now();
  const buildDiag = (): NonNullable<Extract<TeamDataWorkerResponse, { ok: true }>['diag']> => ({
    op: msg.op,
    ...(msg.payload && 'teamName' in msg.payload ? { teamName: msg.payload.teamName } : {}),
    ...(msg.payload && 'taskId' in msg.payload ? { taskId: msg.payload.taskId } : {}),
    totalMs: Date.now() - startedAt,
  });
  try {
    switch (msg.op) {
      case 'warmup': {
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'getTeamData': {
        const { teamName, options, runtimeSnapshot } = msg.payload;
        const result = await runHeavyRead(() =>
          runtimeSnapshots.run(runtimeSnapshot, () =>
            teamDataService.getTeamData(teamName, options)
          )
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'getMessagesPage': {
        const result = await runHeavyRead(() =>
          teamDataService.getMessagesPage(msg.payload.teamName, msg.payload.options)
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'getMemberActivityMeta': {
        const result = await runHeavyRead(() =>
          teamDataService.getMemberActivityMeta(msg.payload.teamName)
        );
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      case 'invalidateTeamConfig': {
        TeamConfigReader.invalidateTeam(msg.payload.teamName);
        teamDataService.invalidateMessageFeed(msg.payload.teamName);
        teamDataService.invalidateTeamRuntimeAdvisories(msg.payload.teamName);
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'invalidateTeamMessageFeed': {
        teamDataService.invalidateMessageFeed(msg.payload.teamName);
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'invalidateMemberRuntimeAdvisory': {
        if (msg.payload.memberName) {
          teamDataService.invalidateMemberRuntimeAdvisory(
            msg.payload.teamName,
            msg.payload.memberName
          );
        } else {
          teamDataService.invalidateTeamRuntimeAdvisories(
            msg.payload.teamName,
            msg.payload.runStartedAtMs
          );
        }
        respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
        break;
      }
      case 'findLogsForTask': {
        const result = await runHeavyRead(async () => {
          const { teamName, taskId, options } = msg.payload;
          const intervalsKey = options?.intervals
            ? options.intervals.map((i) => `${i.startedAt}~${i.completedAt ?? ''}`).join(',')
            : '';
          const cacheKey = `${teamName}:${taskId}:${options?.owner ?? ''}:${options?.status ?? ''}:${options?.since ?? ''}:${intervalsKey}`;

          // Check result cache
          const cached = logsResultCache.get(cacheKey);
          if (cached && Date.now() - cached.cachedAt < LOGS_CACHE_TTL_MS) {
            return cached.result;
          }

          // Dedup concurrent calls
          let promise = logsInFlight.get(cacheKey) as Promise<MemberLogSummary[]> | undefined;
          if (!promise) {
            promise = logsFinder
              .findLogsForTask(teamName, taskId, options)
              .then((result) => {
                logsResultCache.set(cacheKey, { result, cachedAt: Date.now() });
                // Cap cache
                if (logsResultCache.size > 100) {
                  const firstKey = logsResultCache.keys().next().value;
                  if (firstKey !== undefined) logsResultCache.delete(firstKey);
                }
                return result;
              })
              .finally(() => {
                logsInFlight.delete(cacheKey);
              });
            logsInFlight.set(cacheKey, promise);
          }
          return promise;
        });
        respond({ id: msg.id, ok: true, result, diag: buildDiag() });
        break;
      }
      default: {
        const _exhaustive: never = msg;
        respond({ id: (_exhaustive as { id: string }).id, ok: false, error: `Unknown op` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[${msg.op}] ${message}`);
    respond({
      id: msg.id,
      ok: false,
      error: message,
      ...(err instanceof RegistryTaskProviderError
        ? { registryFailure: serializeRegistryBoardReadFailure(err) }
        : {}),
    });
  }
});

logger.info('team-data-worker started');
