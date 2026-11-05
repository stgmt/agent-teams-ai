import * as path from 'node:path';

import { JsonTaskCommentNotificationJournalStore } from '@main/services/team/JsonTaskCommentNotificationJournalStore';
import { JsonTaskStallJournalStore } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { createLogger } from '@shared/utils/logger';

import {
  COMMENT_JOURNAL_STORE_ID,
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
  STALL_JOURNAL_STORE_ID,
} from '../../contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '../../core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '../../core/application/KeyedMutex';
import {
  areCommentJournalRecordSetsEquivalent,
  resolveCommentJournalRecordConflict,
} from '../adapters/output/commentJournalEntryRecordMapper';
import { CommentJournalLegacyJsonSource } from '../adapters/output/CommentJournalLegacyJsonSource';
import { SqliteTaskCommentNotificationJournalStore } from '../adapters/output/SqliteTaskCommentNotificationJournalStore';
import { SqliteTaskStallJournalStore } from '../adapters/output/SqliteTaskStallJournalStore';
import {
  areStallJournalRecordSetsEquivalent,
  resolveStallJournalRecordConflict,
} from '../adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '../adapters/output/StallJournalLegacyJsonSource';
import {
  getInternalStorageRecoveryDetails,
  internalStorageRecoveryPaths,
  mightHaveInternalStorageFiles,
} from '../infrastructure/internalStorageRecoveryState';
import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import { BackendSelectingTaskCommentNotificationJournalStore } from './BackendSelectingTaskCommentNotificationJournalStore';
import { BackendSelectingTaskStallJournalStore } from './BackendSelectingTaskStallJournalStore';
import { InternalStorageBackendSelector } from './InternalStorageBackendSelector';

import type { InternalStorageBackendKind } from '../../contracts/internalStorageContracts';
import type { MemberWorkSyncStorageGateway } from '../../core/application/ports';
import type { ApplicationCommandLedgerStorageGateway } from '@features/application-command-ledger';
import type {
  CustomTeamTemplateStorageGateway,
  ListCustomTeamTemplatesResult,
} from '@features/custom-team-templates/contracts';
import type { TaskStallJournalStore } from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskCommentNotificationJournalStore } from '@main/services/team/TaskCommentNotificationJournalStore';

const logger = createLogger('Feature:InternalStorage');

export interface InternalStorageFeatureDeps {
  /** Usually app.getPath('userData'); the SQLite file lives in a subfolder. */
  userDataPath: string;
}

export interface InternalStorageMemberWorkSyncBackend {
  gateway: MemberWorkSyncStorageGateway;
  selector: InternalStorageBackendSelector;
  fallbackRequiresReplica?: boolean;
}

export interface InternalStorageApplicationCommandLedgerBackend {
  gateway: ApplicationCommandLedgerStorageGateway;
  selector: InternalStorageBackendSelector;
}

export interface InternalStorageCustomTeamTemplatesBackend {
  /**
   * Worker-backed SQLite gateway, or null if the worker is unavailable.
   * Template data has no JSON fallback; diagnostics remain available.
   */
  gateway: CustomTeamTemplateStorageGateway | null;
  /** Safe, read-only diagnosis even when no worker gateway can be created. */
  diagnoseStorage?: (storageReadFailed?: boolean) => Promise<ListCustomTeamTemplatesResult | null>;
}

export interface InternalStorageFeature {
  taskStallJournalStore: TaskStallJournalStore;
  taskCommentNotificationJournalStore: TaskCommentNotificationJournalStore;
  /**
   * Raw SQLite backend handle for the member-work-sync feature, which builds
   * its own store on top (its ports live in that feature). The selector fails
   * closed when the worker is unavailable instead of selecting JSON.
   */
  memberWorkSyncBackend: InternalStorageMemberWorkSyncBackend | null;
  /**
   * SQLite gateway for the application-command-ledger feature. Null when the
   * worker bundle is unavailable, so callers must leave durable commands off.
   */
  applicationCommandLedgerBackend: InternalStorageApplicationCommandLedgerBackend | null;
  /** Worker gateway when available, plus diagnostics when it is unavailable. */
  customTeamTemplatesBackend: InternalStorageCustomTeamTemplatesBackend;
  /** Forces the lazy backend decision for startup diagnostics and packaged smoke checks. */
  probeBackend(): Promise<InternalStorageBackendKind>;
  getBackendKind(): InternalStorageBackendKind;
  dispose(): Promise<void>;
}

export function getInternalStorageDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, INTERNAL_STORAGE_DIRNAME, INTERNAL_STORAGE_DATABASE_FILENAME);
}

export function createInternalStorageFeature(
  deps: InternalStorageFeatureDeps
): InternalStorageFeature {
  const databasePath = getInternalStorageDatabasePath(deps.userDataPath);
  // Replica ownership is per team/store. A missing replica means that store was
  // never touched through SQLite; a dirty replica fails closed on its own.
  // The selector blocks JSON if the worker is unavailable because JSON and
  // SQLite clients cannot prove exclusive backend ownership.
  const fallbackRequiresReplica = false;
  const client = new InternalStorageWorkerClient({ databasePath });
  const workerAvailable = client.isAvailable();
  const jsonStallStore = new JsonTaskStallJournalStore();
  const jsonCommentStore = new JsonTaskCommentNotificationJournalStore();

  if (!workerAvailable) {
    logger.warn(
      `internal-storage worker bundle not found; JSON fallback is disabled. expectedOneOf=${client
        .getWorkerPathCandidatesForDiagnostics()
        .join(',')}`
    );
  }

  const selector = new InternalStorageBackendSelector(
    () =>
      workerAvailable
        ? client.ping()
        : Promise.reject(new Error('internal-storage worker bundle is unavailable')),
    () => getInternalStorageRecoveryDetails(databasePath) !== null,
    // JSON writers and SQLite clients do not share a lock spanning their
    // entire operations. Even an absent database can appear after selection.
    () => true
  );

  const stallImporter = new ImportLegacyJsonStoreUseCase({
    storeId: STALL_JOURNAL_STORE_ID,
    source: new StallJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadStallJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceStallJournalEntries(teamName, records),
    recordIdentity: (record) => record.epochKey,
    resolveConflict: resolveStallJournalRecordConflict,
    areEquivalent: areStallJournalRecordSetsEquivalent,
    recordImport: (teamName, entryCount) =>
      client.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, entryCount),
    hasRecordedImport: (teamName) => client.hasStoreImport(STALL_JOURNAL_STORE_ID, teamName),
  });
  const sqliteStallStore = new SqliteTaskStallJournalStore({
    gateway: client,
    importer: stallImporter,
    mutex: new KeyedMutex(),
  });

  const commentImporter = new ImportLegacyJsonStoreUseCase({
    storeId: COMMENT_JOURNAL_STORE_ID,
    source: new CommentJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadCommentJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceCommentJournalEntries(teamName, records),
    recordIdentity: (record) => record.key,
    resolveConflict: resolveCommentJournalRecordConflict,
    areEquivalent: areCommentJournalRecordSetsEquivalent,
    recordImport: (teamName, entryCount) =>
      client.recordStoreImport(COMMENT_JOURNAL_STORE_ID, teamName, entryCount),
    hasRecordedImport: (teamName) => client.hasStoreImport(COMMENT_JOURNAL_STORE_ID, teamName),
  });
  const sqliteCommentStore = new SqliteTaskCommentNotificationJournalStore({
    gateway: client,
    importer: commentImporter,
    mutex: new KeyedMutex(),
  });

  return {
    taskStallJournalStore: new BackendSelectingTaskStallJournalStore(
      selector,
      sqliteStallStore,
      jsonStallStore,
      { fallbackRequiresReplica, logger }
    ),
    taskCommentNotificationJournalStore: new BackendSelectingTaskCommentNotificationJournalStore(
      selector,
      sqliteCommentStore,
      jsonCommentStore,
      { fallbackRequiresReplica, logger }
    ),
    memberWorkSyncBackend: { gateway: client, selector, fallbackRequiresReplica },
    applicationCommandLedgerBackend: workerAvailable ? { gateway: client, selector } : null,
    customTeamTemplatesBackend: {
      gateway: workerAvailable ? client : null,
      diagnoseStorage: async (storageReadFailed = false) => {
        const kind = await selector.probe();
        if (kind === 'recovery-required') {
          try {
            const recovery = getInternalStorageRecoveryDetails(databasePath);
            if (recovery) {
              const { kind: recoveryKind, ...paths } = recovery;
              return {
                status: recoveryKind === 'interrupted' ? 'recoveryInterrupted' : 'recoveryRequired',
                ...paths,
              };
            }
          } catch {
            // Marker access can itself fail; preserve the known recovery state.
          }
          // A typed corruption error without a readable marker is still known
          // damage, but the marker's publication cannot be confirmed.
          return {
            status: 'recoveryRequired',
            ...internalStorageRecoveryPaths(databasePath),
            markerWriteFailed: true,
          };
        }
        if (kind === 'verification-required' || storageReadFailed) {
          const resolved = path.resolve(databasePath);
          return {
            status: mightHaveInternalStorageFiles(databasePath)
              ? 'storageVerificationRequired'
              : 'storageSafetyUnavailable',
            storageDirectory: path.dirname(resolved),
            databasePath: resolved,
          };
        }
        return null;
      },
    },
    probeBackend: () => selector.probe(),
    getBackendKind: () => selector.getBackendKind(),
    dispose: () => client.close(),
  };
}
