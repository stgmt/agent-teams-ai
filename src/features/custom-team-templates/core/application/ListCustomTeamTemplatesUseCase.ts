import type { CustomTeamTemplateStorageGateway } from './ports';
import type { ListCustomTeamTemplatesResult } from '@features/custom-team-templates/contracts';

export interface ListCustomTeamTemplatesUseCaseDeps {
  /** Null when the SQLite worker bundle is unavailable in this environment. */
  gateway: CustomTeamTemplateStorageGateway | null;
  diagnoseStorage?: (storageReadFailed?: boolean) => Promise<ListCustomTeamTemplatesResult | null>;
}

/**
 * Reads the saved template library.
 *
 * Read-only by design: A1 exposes no update or delete operation, so this use
 * case cannot mutate the library even by accident.
 *
 * An empty library and an unavailable or failing store are kept strictly
 * apart. A store failure is never reported as an empty library, because that
 * would tell the user their templates are gone when they are merely unreadable,
 * and records that cannot be reconstructed are surfaced with their ids instead
 * of being dropped or reinterpreted as valid empty templates.
 */
export class ListCustomTeamTemplatesUseCase {
  constructor(private readonly deps: ListCustomTeamTemplatesUseCaseDeps) {}

  async execute(): Promise<ListCustomTeamTemplatesResult> {
    if (this.deps.diagnoseStorage) {
      try {
        const diagnostic = await this.deps.diagnoseStorage();
        if (diagnostic) return diagnostic;
      } catch {
        return { status: 'storageUnavailable' };
      }
    }
    const gateway = this.deps.gateway;
    if (!gateway) {
      return { status: 'storageUnavailable' };
    }

    let listed;
    try {
      listed = await gateway.customTeamTemplateList();
    } catch {
      // The worker may fail after an earlier successful backend selection.
      // Diagnose the failure without repeating the library read.
      try {
        const diagnostic = await this.deps.diagnoseStorage?.(true);
        if (diagnostic) return diagnostic;
      } catch {
        // A failed diagnosis cannot turn a failed read into an empty library.
      }
      return { status: 'storageUnavailable' };
    }

    if (listed.recoveryRequired) {
      const { kind, ...paths } = listed.recoveryRequired;
      return {
        status: kind === 'interrupted' ? 'recoveryInterrupted' : 'recoveryRequired',
        ...paths,
      };
    }
    if (listed.unreadableRecords.length > 0) {
      return {
        status: 'hasUnreadableRecords',
        templates: listed.templates,
        unreadableRecords: listed.unreadableRecords,
      };
    }
    if (listed.templates.length === 0) {
      return { status: 'empty' };
    }
    return { status: 'ready', templates: listed.templates };
  }
}
