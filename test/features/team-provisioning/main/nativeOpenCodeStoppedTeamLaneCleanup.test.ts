// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TeamOperationQueue } from '../../../../src/features/team-provisioning/core/application/TeamOperationQueue';
import { createNativeOpenCodeStoppedTeamLaneCleanup } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeStoppedTeamLaneCleanup';
import {
  readOpenCodeRuntimeLaneIndex,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM = 'alpha';
const LANE = 'secondary:opencode:builder';

let claudeBase = '';
let teamsBasePath = '';
let deletedSecondary: string[] = [];
let clearedPrimary = 0;
let warnings: string[] = [];

beforeEach(async () => {
  claudeBase = await mkdtemp(join(tmpdir(), 'native-stopped-'));
  setClaudeBasePathOverride(claudeBase);
  teamsBasePath = join(claudeBase, 'teams');
  await mkdir(join(teamsBasePath, TEAM), { recursive: true });
  deletedSecondary = [];
  clearedPrimary = 0;
  warnings = [];
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await rm(claudeBase, { recursive: true, force: true });
});

function subject(options: { canDeliver?: boolean; owned?: boolean } = {}) {
  return createNativeOpenCodeStoppedTeamLaneCleanup({
    teamsBasePath,
    queue: new TeamOperationQueue(),
    isManagedByThisProfile: async () => options.owned !== false,
    readConfig: async () => null,
    readMembersMeta: async () => [],
    canDeliverToOpenCodeRuntimeForTeam: () => options.canDeliver === true,
    getOpenCodeRuntimeAdapter: () => null,
    deleteSecondaryRuntimeRun: (teamName, laneId) => deletedSecondary.push(`${teamName}:${laneId}`),
    clearPrimaryRuntimeRun: () => {
      clearedPrimary += 1;
    },
    logger: { info: () => undefined, warn: (message) => warnings.push(message) },
  });
}

describe('native stopped-team lane cleanup', () => {
  it('does not sweep lanes belonging to another profile', async () => {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath, teamName: TEAM, laneId: LANE, state: 'active',
    });
    await subject({ owned: false }).stopLanesForStoppedTeam(TEAM);
    const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, TEAM);
    expect(laneIndex?.lanes[LANE]?.state).toBe('active');
    expect(deletedSecondary).toEqual([]);
    expect(clearedPrimary).toBe(0);
  });

  it('reports nothing to stop for a team that never ran a lane', async () => {
    await expect(subject().stopLanesForStoppedTeam(TEAM)).resolves.toBe(0);
    expect(deletedSecondary).toEqual([]);
    expect(clearedPrimary).toBe(0);
  });

  it('clears the storage of an abandoned lane that no process backs any more', async () => {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath,
      teamName: TEAM,
      laneId: LANE,
      state: 'active',
    });

    const stopped = await subject().stopLanesForStoppedTeam(TEAM);

    expect(stopped).toBe(0);
    const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, TEAM);
    expect(laneIndex?.lanes[LANE]).toBeUndefined();
  });

  it('leaves a lane alone while the team still has a runtime to deliver to', async () => {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath,
      teamName: TEAM,
      laneId: LANE,
      state: 'active',
    });
    await subject({ canDeliver: true }).stopLanesForStoppedTeam(TEAM);

    const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, TEAM);
    expect(laneIndex?.lanes[LANE]?.state).toBe('active');
  });

  it('survives a shutdown sweep fired in the background', async () => {
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath,
      teamName: TEAM,
      laneId: LANE,
      state: 'active',
    });

    subject().stopLanesForStoppedTeamInBackground(TEAM);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(warnings.filter((message) => message.includes('Failed to clean up'))).toEqual([]);
  });
});
