import * as path from 'path';

import { RegistryTaskClient } from '@main/services/team/registry/RegistryTaskClient';
import {
  SPEC_REGISTRY_TOKEN_ENV,
  SPEC_REGISTRY_TOKEN_FILE_ENV,
  SPEC_REGISTRY_URL_ENV,
} from '@main/services/team/registry/RegistryTaskClientConfig';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';

import type { TeamConfig } from '@shared/types';

import { afterEach, vi } from 'vitest';

// Restore only the task-service spies owned by this helper.
const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) restore();
});

/** Use test-only registry credentials without consulting a real user's token file. */
export function isolateRegistryCredentialForProvisioningTest(tempRoot: string): void {
  const previous = new Map([
    [SPEC_REGISTRY_TOKEN_ENV, process.env[SPEC_REGISTRY_TOKEN_ENV]],
    [SPEC_REGISTRY_TOKEN_FILE_ENV, process.env[SPEC_REGISTRY_TOKEN_FILE_ENV]],
    [SPEC_REGISTRY_URL_ENV, process.env[SPEC_REGISTRY_URL_ENV]],
  ]);

  process.env[SPEC_REGISTRY_TOKEN_ENV] = 'provisioning-test-registry-token';
  process.env[SPEC_REGISTRY_TOKEN_FILE_ENV] = path.join(
    tempRoot,
    '.absent-test-registry-token'
  );
  process.env[SPEC_REGISTRY_URL_ENV] = 'http://127.0.0.1:8650/mcp';

  restorers.push(() => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

/** Non-task provisioning tests must not persist intervals through the registry. */
export function isolateTaskActivityIntervalsForProvisioningTest(): void {
  const methods = [
    'repairStaleIntervalsAfterCrash',
    'resumeActiveIntervalsForMember',
    'resumeActiveIntervalsForMembers',
    'pauseActiveIntervalsForMember',
    'pauseActiveIntervalsForTeam',
  ] as const;
  const result = { changedTasks: 0 };
  const spies = methods.map((method) =>
    vi
      .spyOn(TeamTaskActivityIntervalService.prototype, method)
      .mockResolvedValue(result)
  );
  restorers.push(() => {
    for (const spy of spies.reverse()) spy.mockRestore();
  });
}

/**
 * Give provisioning-only fixtures a disposable canonical scope and an empty
 * fake registry response. TeamTaskReader remains real; no registry HTTP is made.
 */
export function isolateAncillaryRegistryTaskReadsForProvisioningTest(
  tempRoot: string
): void {
  isolateRegistryCredentialForProvisioningTest(tempRoot);

  const readConfigSnapshot = TeamConfigReader.prototype.getConfigSnapshot;
  const configReader = vi
    .spyOn(TeamConfigReader.prototype, 'getConfigSnapshot')
    .mockImplementation(async function (
      this: TeamConfigReader,
      teamName: string
    ): Promise<TeamConfig | null> {
      const config = await readConfigSnapshot.call(this, teamName);
      if (config?.specProject?.trim() && config.specSlug?.trim()) {
        return config;
      }
      const baseConfig = config ?? { name: teamName, members: [] };
      const testScope =
        path
          .basename(tempRoot)
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'temp';
      const teamScope =
        teamName
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'team';
      const repo = `${testScope}-${teamScope}`;
      return {
        ...baseConfig,
        specProject: `provisioning-tests/${repo}`,
        specSlug: 'provisioning-test',
      };
    });
  restorers.push(() => configReader.mockRestore());

  const registryClient = vi
    .spyOn(RegistryTaskClient, 'create')
    .mockImplementation(async () => ({
      listTasks: async (input: Parameters<RegistryTaskClient['listTasks']>[0]) => {
        if (
          !input.project.startsWith('provisioning-tests/') ||
          input.spec !== 'provisioning-test'
        ) {
          throw new Error('Unexpected non-fixture registry scope in provisioning test');
        }
        return [];
      },
    }) as unknown as RegistryTaskClient);
  restorers.push(() => registryClient.mockRestore());

  isolateTaskActivityIntervalsForProvisioningTest();
}

/** Keep non-task provisioning tests independent of the registry-backed task store. */
export function isolateTaskActivityRepairForProvisioningTest(): void {
  const repair = vi
    .spyOn(TeamTaskActivityIntervalService.prototype, 'repairStaleIntervalsAfterCrash')
    .mockResolvedValue({ changedTasks: 0 });
  restorers.push(() => repair.mockRestore());
}

/** Lead relay/message tests observe lifecycle behavior, not task interval persistence. */
export function isolateLeadTaskIntervalsForProvisioningTest(): void {
  const resume = vi
    .spyOn(TeamTaskActivityIntervalService.prototype, 'resumeActiveIntervalsForMember')
    .mockResolvedValue({ changedTasks: 0 });
  const pause = vi
    .spyOn(TeamTaskActivityIntervalService.prototype, 'pauseActiveIntervalsForMember')
    .mockResolvedValue({ changedTasks: 0 });
  restorers.push(() => resume.mockRestore());
  restorers.push(() => pause.mockRestore());
}
