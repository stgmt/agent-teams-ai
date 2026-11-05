import * as fs from 'node:fs';
import * as path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
  getInternalStorageRecoveryDetails,
  internalStorageRecoveryPaths,
  InternalStorageRecoveryRequiredError,
} from '../internalStorageRecoveryState';

import {
  ApplicationCommandLedgerWorkerOps,
  handleApplicationCommandLedgerOp,
} from './applicationCommandLedgerWorkerOps';
import {
  CustomTeamTemplateWorkerOps,
  handleCustomTeamTemplateOp,
} from './customTeamTemplatesWorkerOps';
import {
  INTERNAL_STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  runInternalStorageMigrations,
} from './internalStorageMigrations';
import {
  commentJournalEntries,
  commentJournalTeams,
  stallJournalEntries,
  storeImports,
} from './internalStorageSchema';
import { parseJournalReplacePayload } from './internalStorageWorkerProtocol';
import { handleMemberWorkSyncOp, MemberWorkSyncWorkerOps } from './memberWorkSyncWorkerOps';

import type {
  CommentJournalEntryRecord,
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '../../../contracts/internalStorageContracts';
import type {
  InternalStorageWorkerOp,
  InternalStorageWorkerRequest,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

// Keep row-count * column-count safely below SQLite's bound-variable limit.
const INSERT_CHUNK_SIZE = 400;

const INTEGRITY_CHECK_ERROR_PREFIX = 'integrity_check failed';

/**
 * Only confirmed corruption may trigger the backup-and-recreate path;
 * transient startup failures (mkdir, driver init, migration bugs) must
 * propagate instead of discarding a healthy database file.
 */
function isLikelyCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message.startsWith(INTEGRITY_CHECK_ERROR_PREFIX)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
  );
}

export interface InternalStorageWorkerCoreOptions {
  databasePath: string;
  /** Injected so tests can pass a Node-ABI build of better-sqlite3. */
  createDatabase(databasePath: string): SqliteDatabase;
  now?(): Date;
}

interface OpenState {
  db: SqliteDatabase;
  orm: BetterSQLite3Database;
  integrity: 'ok' | 'recovered';
}

/**
 * Synchronous op handlers around a single better-sqlite3 connection. Runs
 * inside the worker thread; the client serializes calls, so no re-entrancy.
 */
export class InternalStorageWorkerCore {
  private state: OpenState | null = null;
  private markerWriteFailure: ReturnType<typeof getInternalStorageRecoveryDetails> = null;
  private readonly applicationCommandLedgerOps = new ApplicationCommandLedgerWorkerOps(
    () => this.open().orm
  );
  private readonly memberWorkSyncOps = new MemberWorkSyncWorkerOps(() => this.open().orm);
  private readonly customTeamTemplateOps = new CustomTeamTemplateWorkerOps(
    () => this.open().orm,
    () => this.options.now?.() ?? new Date()
  );

  constructor(private readonly options: InternalStorageWorkerCoreOptions) {}

  handle(op: InternalStorageWorkerOp, payload: InternalStorageWorkerRequest['payload']): unknown {
    switch (op) {
      case 'ping':
        return this.ping();
      case 'stallJournal.load':
        return this.loadStallJournalEntries((payload as { teamName: string }).teamName);
      case 'stallJournal.replace': {
        const typed = parseJournalReplacePayload('stallJournal.replace', payload);
        this.replaceStallJournalEntries(typed.teamName, typed.entries);
        return null;
      }
      case 'commentJournal.load':
        return this.loadCommentJournalEntries((payload as { teamName: string }).teamName);
      case 'commentJournal.replace': {
        const typed = parseJournalReplacePayload('commentJournal.replace', payload);
        this.replaceCommentJournalEntries(typed.teamName, typed.entries);
        return null;
      }
      case 'commentJournal.exists':
        return this.commentJournalExists((payload as { teamName: string }).teamName);
      case 'commentJournal.ensureInitialized':
        this.ensureCommentJournalInitialized((payload as { teamName: string }).teamName);
        return null;
      case 'storeImports.record': {
        const typed = payload as { storeId: string; teamName: string; entryCount: number };
        this.recordStoreImport(typed.storeId, typed.teamName, typed.entryCount);
        return null;
      }
      case 'storeImports.has': {
        const typed = payload as { storeId: string; teamName: string };
        return this.hasStoreImport(typed.storeId, typed.teamName);
      }
      case 'close':
        this.close();
        return null;
      default: {
        if (typeof op === 'string' && op.startsWith('appCommandLedger.')) {
          return handleApplicationCommandLedgerOp(this.applicationCommandLedgerOps, op, payload);
        }
        if (typeof op === 'string' && op.startsWith('mws.')) {
          return handleMemberWorkSyncOp(this.memberWorkSyncOps, op, payload);
        }
        if (typeof op === 'string' && op.startsWith('customTemplate.')) {
          // The list is a diagnostic and must work even when ping/open is
          // blocked by a damaged or previously interrupted database.
          let recovery =
            this.markerWriteFailure ?? getInternalStorageRecoveryDetails(this.options.databasePath);
          if (!recovery) {
            try {
              this.open();
            } catch (error) {
              recovery =
                this.markerWriteFailure ??
                getInternalStorageRecoveryDetails(this.options.databasePath);
              if (!recovery || op !== 'customTemplate.list') throw error;
            }
            recovery ??= getInternalStorageRecoveryDetails(this.options.databasePath);
          }
          if (recovery) {
            if (op === 'customTemplate.list')
              return { templates: [], unreadableRecords: [], recoveryRequired: recovery };
            throw new Error('Custom template storage requires manual recovery');
          }
          return handleCustomTeamTemplateOp(this.customTeamTemplateOps, op, payload);
        }
        throw new Error(`Unknown internal-storage op: ${String(op)}`);
      }
    }
  }

  private ping(): InternalStorageBackendInfo {
    const state = this.open();
    return {
      driver: 'better-sqlite3',
      databasePath: this.options.databasePath,
      schemaVersion: readSchemaVersion(state.db),
      integrity: state.integrity,
    };
  }

  private loadStallJournalEntries(teamName: string): StallJournalEntryRecord[] {
    const { orm } = this.open();
    return orm
      .select()
      .from(stallJournalEntries)
      .where(eq(stallJournalEntries.teamName, teamName))
      .all();
  }

  private replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): void {
    const { orm } = this.open();
    orm.transaction((tx) => {
      tx.delete(stallJournalEntries).where(eq(stallJournalEntries.teamName, teamName)).run();
      for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
        tx.insert(stallJournalEntries)
          .values(entries.slice(start, start + INSERT_CHUNK_SIZE))
          .run();
      }
    });
  }

  private loadCommentJournalEntries(teamName: string): CommentJournalEntryRecord[] {
    const { orm } = this.open();
    return orm
      .select()
      .from(commentJournalEntries)
      .where(eq(commentJournalEntries.teamName, teamName))
      .all();
  }

  /**
   * Replaces the team's journal rows AND marks the team as initialized in the
   * same transaction — a journal that was written (even with zero entries)
   * must report exists()=true, otherwise the seeding baseline re-runs and the
   * lead gets re-notified about historical comments.
   */
  private replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): void {
    const { orm } = this.open();
    const initializedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm.transaction((tx) => {
      tx.delete(commentJournalEntries).where(eq(commentJournalEntries.teamName, teamName)).run();
      for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
        tx.insert(commentJournalEntries)
          .values(entries.slice(start, start + INSERT_CHUNK_SIZE))
          .run();
      }
      tx.insert(commentJournalTeams)
        .values({ teamName, initializedAt })
        .onConflictDoNothing()
        .run();
    });
  }

  private commentJournalExists(teamName: string): boolean {
    const { orm } = this.open();
    const rows = orm
      .select({ teamName: commentJournalTeams.teamName })
      .from(commentJournalTeams)
      .where(eq(commentJournalTeams.teamName, teamName))
      .all();
    return rows.length > 0;
  }

  private ensureCommentJournalInitialized(teamName: string): void {
    const { orm } = this.open();
    const initializedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm.insert(commentJournalTeams).values({ teamName, initializedAt }).onConflictDoNothing().run();
  }

  private recordStoreImport(storeId: string, teamName: string, entryCount: number): void {
    const { orm } = this.open();
    const importedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm
      .insert(storeImports)
      .values({ storeId, teamName, importedAt, entryCount })
      .onConflictDoUpdate({
        target: [storeImports.storeId, storeImports.teamName],
        set: { importedAt, entryCount },
      })
      .run();
  }

  private hasStoreImport(storeId: string, teamName: string): boolean {
    const { orm } = this.open();
    return (
      orm
        .select({ storeId: storeImports.storeId })
        .from(storeImports)
        .where(and(eq(storeImports.storeId, storeId), eq(storeImports.teamName, teamName)))
        .all().length > 0
    );
  }

  close(): void {
    if (!this.state) {
      return;
    }
    const { db } = this.state;
    this.state = null;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  private open(): OpenState {
    if (this.markerWriteFailure || getInternalStorageRecoveryDetails(this.options.databasePath)) {
      throw new InternalStorageRecoveryRequiredError('Internal storage requires manual recovery');
    }
    if (this.state) {
      return this.state;
    }
    try {
      const db = this.openOnce();
      this.state = { db, orm: drizzle(db), integrity: 'ok' };
    } catch (error) {
      if (!isLikelyCorruptionError(error)) throw error;
      // A live connection from another app version or process can continue to
      // write the old inode after rename on POSIX. We cannot prove exclusivity,
      // so preserve every database file and require an offline operator choice.
      try {
        this.markTemplateRecoveryRequired();
      } catch (markerError) {
        // Keep the known result in this worker even if the marker write could
        // not be confirmed. Listing is diagnostic and never retries the write.
        this.markerWriteFailure = {
          kind: 'damaged',
          ...internalStorageRecoveryPaths(this.options.databasePath),
          markerWriteFailed: true,
        };
        throw new InternalStorageRecoveryRequiredError(
          'Internal storage is damaged and its recovery marker could not be created; manual recovery is required',
          { cause: markerError }
        );
      }
      throw new InternalStorageRecoveryRequiredError(
        'Internal storage is damaged; manual recovery is required',
        { cause: error }
      );
    }
    return this.state;
  }

  private markTemplateRecoveryRequired(): void {
    try {
      fs.writeFileSync(
        `${this.options.databasePath}.templates-recovery-required`,
        'Internal storage is damaged. Stop all instances and inspect the original files before removing this marker.\n',
        { flag: 'wx', mode: 0o600 }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private openOnce(): SqliteDatabase {
    fs.mkdirSync(path.dirname(this.options.databasePath), { recursive: true });
    const db = this.options.createDatabase(this.options.databasePath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      const integrityResult = db.pragma('integrity_check', { simple: true });
      if (integrityResult !== 'ok') {
        throw new Error(`integrity_check failed: ${String(integrityResult)}`);
      }
      const schemaBefore = readSchemaVersion(db);
      if (schemaBefore > INTERNAL_STORAGE_SCHEMA_VERSION) {
        // A newer app version already migrated this database. Schema v1+ is
        // append-only, so reading known tables is safe; never migrate down.
        return db;
      }
      runInternalStorageMigrations(db);
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // preserve the original error
      }
      throw error;
    }
  }
}
