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
 * A recovery marker or unverifiable worker blocks both backends. JSON fallback
 * is allowed only when the caller can prove that backend switching is isolated.
 * After a successful ping a later error never silently changes backends.
 */
export class InternalStorageBackendSelector {
  private decision: Promise<InternalStorageBackendKind> | null = null;
  private backendKind: InternalStorageBackendKind = 'sqlite';
  private backendInfo: InternalStorageBackendInfo | null = null;

  constructor(
    private readonly ping: () => Promise<InternalStorageBackendInfo>,
    private readonly recoveryRequired: () => boolean = () => false,
    private readonly fallbackMayDiverge: () => boolean = () => true
  ) {}

  /**
   * Reports the decided backend. Until the first store access resolves the
   * ping this optimistically reads 'sqlite'; treat it as diagnostics, not as
   * a synchronization primitive.
   */
  getBackendKind(): InternalStorageBackendKind {
    if (this.backendKind === 'recovery-required') return this.backendKind;
    const marker = this.inspectRecoveryMarker();
    if (marker === 'present') this.backendKind = 'recovery-required';
    else if (marker === 'unknown') this.backendKind = 'verification-required';
    else if (this.backendKind === 'json-fallback' && this.fallbackMayDiverge())
      this.backendKind = 'verification-required';
    return this.backendKind;
  }

  private inspectRecoveryMarker(): 'present' | 'absent' | 'unknown' {
    try {
      return this.recoveryRequired() ? 'present' : 'absent';
    } catch {
      // An unreadable marker must never make a fallback look safe.
      return 'unknown';
    }
  }

  getBackendInfo(): InternalStorageBackendInfo | null {
    return this.backendInfo;
  }

  async select<T>(sqliteBackend: T, jsonBackend: T): Promise<T> {
    const kind = await this.probe();
    if (kind === 'recovery-required') throw new Error('Internal storage requires manual recovery');
    if (kind === 'verification-required')
      throw new Error(
        'Internal storage cannot be verified; JSON fallback is disabled while the worker is unavailable'
      );
    return kind === 'sqlite' ? sqliteBackend : jsonBackend;
  }

  /** Refuses both backends once recovery is observed, including after fallback. */
  async probe(): Promise<InternalStorageBackendKind> {
    const safety = this.getBackendKind();
    if (safety === 'recovery-required' || safety === 'verification-required') return safety;
    const kind = await this.resolve();
    const current = this.getBackendKind();
    if (current === 'recovery-required' || current === 'verification-required') return current;
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
          const marker = this.inspectRecoveryMarker();
          if (isInternalStorageRecoveryRequiredError(error) || marker === 'present') {
            this.backendKind = 'recovery-required';
            logger.error(
              'internal-storage requires manual recovery; both SQLite and JSON are blocked',
              error
            );
            return this.backendKind;
          }
          if (marker === 'unknown' || this.fallbackMayDiverge()) {
            this.backendKind = 'verification-required';
            logger.error(
              'internal-storage worker unavailable or database unverifiable; JSON fallback is disabled',
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
