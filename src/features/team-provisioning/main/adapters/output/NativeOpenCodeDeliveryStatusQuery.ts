import { decideOpenCodeRuntimeDeliveryAdvisory } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { OpenCodeRuntimeDeliveryProofReader } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { createOpenCodePromptDeliveryLedger } from '@main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import {
  getOpenCodeRuntimeDeliveryStatus,
  type OpenCodeRuntimeDeliveryStatusPorts,
} from '@main/services/team/provisioning/OpenCodePromptDeliveryQueries';

import type { OpenCodeRuntimeDeliveryStatus, TeamConfig, TeamTask } from '@shared/types';

/**
 * What the native owner can answer about a delivered prompt without a runtime.
 *
 * Reading a delivery status is a pure store question: the lane index says which
 * lanes exist, the retained ledger says what happened to the message, and reply
 * proof comes from the inbox and the task ledger. None of that needs the legacy
 * provisioning service, so the native messaging surface can answer it directly.
 */
export interface NativeOpenCodeDeliveryStatusDependencies {
  teamsBasePath: string;
  readInbox(teamName: string, inboxName: string): Promise<readonly unknown[]>;
  readTasks(teamName: string): Promise<readonly TeamTask[]>;
  readConfig(teamName: string): Promise<TeamConfig | null>;
}

export interface NativeOpenCodeDeliveryStatusQuery {
  getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null>;
}

export function createNativeOpenCodeDeliveryStatusQuery(
  deps: NativeOpenCodeDeliveryStatusDependencies
): NativeOpenCodeDeliveryStatusQuery {
  const proofReader = new OpenCodeRuntimeDeliveryProofReader({
    inboxReader: {
      getMessagesFor: async (teamName, inboxName) =>
        (await deps.readInbox(teamName, inboxName)) as never,
    },
    taskReader: { getTasks: async (teamName) => [...(await deps.readTasks(teamName))] },
    configReader: {
      getConfigSnapshot: (teamName) => deps.readConfig(teamName),
      getConfig: (teamName) => deps.readConfig(teamName),
    },
  });

  return {
    async getOpenCodeRuntimeDeliveryStatus(teamName, messageId) {
      const ports: OpenCodeRuntimeDeliveryStatusPorts = {
        teamsBasePath: deps.teamsBasePath,
        createOpenCodePromptDeliveryLedger: (ledgerTeam, laneId) =>
          createOpenCodePromptDeliveryLedger(ledgerTeam, laneId, {
            teamsBasePath: deps.teamsBasePath,
          }),
        decideOpenCodeRuntimeDeliveryUserFacingAdvisory: async (record) => {
          const records = await ports
            .createOpenCodePromptDeliveryLedger(record.teamName, record.laneId)
            .list()
            .catch(() => []);
          const latest = records.find((candidate) => candidate.id === record.id);
          if (!latest) return { record, decision: { action: 'suppress' } };
          const proofIndex = await proofReader
            .readProofIndex({
              teamName: latest.teamName,
              activeMemberKeys: new Set([latest.memberName.trim().toLowerCase()]),
              recordsByMember: new Map([
                [
                  latest.memberName.trim().toLowerCase(),
                  records.filter(
                    (candidate) =>
                      candidate.memberName.trim().toLowerCase() ===
                      latest.memberName.trim().toLowerCase()
                  ),
                ],
              ]),
            })
            .catch(() => null);
          return {
            record: latest,
            decision: decideOpenCodeRuntimeDeliveryAdvisory({
              record: latest,
              proof: proofIndex?.getSnapshot(latest.memberName, latest) ?? null,
            }),
          };
        },
      };
      return await getOpenCodeRuntimeDeliveryStatus(teamName, messageId, ports);
    },
  };
}
