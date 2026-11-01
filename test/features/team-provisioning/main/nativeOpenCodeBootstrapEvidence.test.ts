// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeBootstrapEvidence } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeBootstrapEvidence';
import { setOpenCodeRuntimeActiveRunManifest } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

const TEAM = 'alpha';
const LANE = 'primary';
const RUN = 'run-1';
const OBSERVED_AT = '2026-11-02T10:00:00.000Z';

let teamsBasePath = '';
let currentRun: string | null = RUN;
let subject: ReturnType<typeof createNativeOpenCodeBootstrapEvidence>;

beforeEach(async () => {
  teamsBasePath = await mkdtemp(join(tmpdir(), 'native-bootstrap-'));
  currentRun = RUN;
  subject = createNativeOpenCodeBootstrapEvidence({
    teamsBasePath,
    resolveCurrentOpenCodeRuntimeRunId: async () => currentRun,
    warn: () => undefined,
  });
});

afterEach(async () => {
  await rm(teamsBasePath, { recursive: true, force: true });
});

async function commit(memberName = 'dev', runId = RUN) {
  await setOpenCodeRuntimeActiveRunManifest({ teamsBasePath, teamName: TEAM, laneId: LANE, runId });
  await subject.commitBootstrapSession({
    teamName: TEAM,
    laneId: LANE,
    runId,
    memberName,
    runtimeSessionId: 'session-abc',
    observedAt: OBSERVED_AT,
  });
}

describe('native bootstrap evidence', () => {
  it('reports a committed session only for the member it belongs to', async () => {
    await commit('dev');

    await expect(
      subject.hasCommittedBootstrapSession({ teamName: TEAM, laneId: LANE, runId: RUN, memberName: 'dev' })
    ).resolves.toBe(true);
    await expect(
      subject.hasCommittedBootstrapSession({
        teamName: TEAM,
        laneId: LANE,
        runId: RUN,
        memberName: 'other',
      })
    ).resolves.toBe(false);
  });

  it('refuses a session belonging to a different run', async () => {
    await commit('dev', 'run-1');

    await expect(
      subject.hasCommittedBootstrapSession({
        teamName: TEAM,
        laneId: LANE,
        runId: 'run-2',
        memberName: 'dev',
      })
    ).resolves.toBe(false);
  });

  it('tracks a run only while the lane is on it', async () => {
    await expect(
      subject.resolveTrackedBootstrapRunId({ teamName: TEAM, laneId: LANE, runId: RUN })
    ).resolves.toBe(RUN);

    currentRun = 'run-2';

    await expect(
      subject.resolveTrackedBootstrapRunId({ teamName: TEAM, laneId: LANE, runId: RUN })
    ).resolves.toBeNull();
  });

  it('has nothing to prove for a team that never bootstrapped', async () => {
    await expect(
      subject.hasCommittedBootstrapSession({ teamName: TEAM, laneId: LANE, runId: RUN, memberName: 'dev' })
    ).resolves.toBe(false);
  });
});
