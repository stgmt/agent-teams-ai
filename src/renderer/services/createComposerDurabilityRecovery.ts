import {
  composerNamespacePrefix,
  composerRecoveryIndexKey,
  composerWorkingIndexKey,
} from '@renderer/utils/composerDraftIdentity';

import { ComposerDurabilityRecovery } from './composerDurabilityRecovery';

import type { ComposerRecoveryRecord, ComposerWorkingRecord } from '@renderer/types/composerDraft';

export function createComposerDurabilityRecovery(
  working: ReadonlyMap<string, ComposerWorkingRecord>,
  recoveries: ReadonlyMap<string, ComposerRecoveryRecord>,
  recovered: (contextId: string, teamName: string) => void
): ComposerDurabilityRecovery {
  return new ComposerDurabilityRecovery({
    capture: (contextId, teamName) => ({
      records: new Map<string, unknown>(
        [...working, ...recoveries].filter(([key]) =>
          key.startsWith(composerNamespacePrefix(contextId, teamName))
        )
      ),
      workingIndexKey: composerWorkingIndexKey(contextId, teamName),
      recoveryIndexKey: composerRecoveryIndexKey(contextId, teamName),
    }),
    recovered,
  });
}
