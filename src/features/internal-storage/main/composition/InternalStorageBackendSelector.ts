import { createLogger } from '@shared/utils/logger';

import { isInternalStorageRecoveryRequiredError } from '../infrastructure/internalStorageRecoveryState';

import type {
  InternalStorageBackendInfo,
  InternalStorageBackendKind,
} from '../../contracts/internalStorageContracts';

const logger = createLogger('Feature:InternalStorage');

/**
 * Decides the storage backend once per session, on first store access, and
 * shares that decision across every store in the feature so state never
 * splits between backends.
 *
 * Ordinary startup failures can select legacy JSON stores. A persisted recovery
 * marker blocks both backends to avoid diverging from a live SQLite process.
 * After a successful ping a later error never silently changes backends.
 */
export class InternalStorageBackendSelector {
  private decision: Promise<InternalStorageBackendKind> | null = null;
  private backendKind: InternalStorageBackendKind = 'sqlite';
  private backendInfo: InternalStorageBackendInfo | null = null;

  constructor(
    private readonly ping: () => Promise<InternalStorageBackendInfo>,
    private readonly recoveryRequired: () => boolean = () => false
  ) {}

  /**
   * Reports the decided backend. Until the first store access resolves the
   * ping this optimistically reads 'sqlite'; treat it as diagnostics, not as
   * a synchronization primitive.
   */
  getBackendKind(): InternalStorageBackendKind {
    if (this.recoveryRequired()) this.backendKind = 'recovery-required';
    return this.backendKind;
  }

  getBackendInfo(): InternalStorageBackendInfo | null {
    return this.backendInfo;
  }

  async select<T>(sqliteBackend: T, jsonBackend: T): Promise<T> {
    const kind = await this.probe();
    if (kind === 'recovery-required') throw new Error('Internal storage requires manual recovery');
    return kind === 'sqlite' ? sqliteBackend : jsonBackend;
  }

  /** Refuses both backends once recovery is observed, including after fallback. */
  async probe(): Promise<InternalStorageBackendKind> {
    if (this.backendKind === 'recovery-required' || this.recoveryRequired()) {
      this.backendKind = 'recovery-required';
      return this.backendKind;
    }
    const kind = await this.resolve();
    if (this.getBackendKind() === 'recovery-required') return 'recovery-required';
    return kind;
  }

  private resolve(): Promise<InternalStorageBackendKind> {
    if (!this.decision) {
      this.decision = this.ping()
        .then((info): InternalStorageBackendKind => {
          this.backendInfo = info;
          const message = `internal-storage backend=sqlite schemaVersion=${info.schemaVersion} integrity=${info.integrity} db=${info.databasePath}`;
          if (info.integrity === 'recovered') {
            logger.warn(message);
          } else {
            logger.info(message);
          }
          return 'sqlite';
        })
        .catch((error: unknown): InternalStorageBackendKind => {
          if (isInternalStorageRecoveryRequiredError(error) || this.recoveryRequired()) {
            this.backendKind = 'recovery-required';
            logger.error(
              'internal-storage requires manual recovery; both SQLite and JSON are blocked',
              error
            );
            return this.backendKind;
          }
          this.backendKind = 'json-fallback';
          logger.error(
            'internal-storage sqlite backend unavailable; falling back to JSON stores for this session',
            error
          );
          return 'json-fallback';
        });
    }
    return this.decision;
  }
}
