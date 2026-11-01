import { createOpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { getOpenCodeLaneScopedRuntimeFilePath } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { OpenCodePromptDeliveryLedgerStore } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

/**
 * The prompt ledger of one lane. One file per lane is the on-disk rule the whole
 * delivery path already follows, so the path lives here once instead of being
 * rebuilt by every reader.
 */
export function createNativeOpenCodePromptDeliveryLedgerFactory(
  teamsBasePath: string
): (teamName: string, laneId: string) => OpenCodePromptDeliveryLedgerStore {
  return (teamName, laneId) =>
    createOpenCodePromptDeliveryLedgerStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath,
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
    });
}
