// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeLaneRecovery } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeLaneRecovery';
import {
  createNativeOpenCodeMemberIdentity,
  type NativeOpenCodeMemberIdentityDependencies,
} from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberIdentity';

function identityDeps(
  overrides: Partial<NativeOpenCodeMemberIdentityDependencies> &
    Pick<NativeOpenCodeMemberIdentityDependencies, 'teamsBasePath' | 'readConfig'>
): NativeOpenCodeMemberIdentityDependencies {
  return {
    readTeamMeta: async () => null,
    readMetaMembers: async () => [],
    readSecondaryRuntimeRuns: async () => [],
    getCurrentOpenCodeRuntimeRunId: () => null,
    ...overrides,
  };
}

import { readOpenCodeRuntimeLaneIndex } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { OpenCodeCommittedBootstrapSessionEvidence } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { PersistedTeamLaunchSnapshot } from '../../../../src/shared/types';

const teamName = 'alpha';
const laneId = 'secondary:opencode:builder';
const created: string[] = [];
let teamsBasePath = '';

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-recovery-'));
  created.push(root);
  teamsBasePath = join(root, 'teams');
  setClaudeBasePathOverride(root);
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const member = { name: 'builder', agentType: 'general-purpose', providerId: 'opencode' } as never;

function launchState(): PersistedTeamLaunchSnapshot {
  return {
    members: {
      builder: {
        name: 'builder',
        providerId: 'opencode',
        laneId,
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
        cwd: '/TEST/alpha',
        runtimePid: 4321,
        agentToolAccepted: true,
      },
    },
  } as never;
}

function build(options: {
  canDeliver: boolean;
  recovered: boolean;
  committedEvidence?: OpenCodeCommittedBootstrapSessionEvidence;
}) {
  const events: string[] = [];
  const cleanups: string[] = [];
  const recovery = createNativeOpenCodeLaneRecovery({
    teamsBasePath,
    identity: createNativeOpenCodeMemberIdentity(identityDeps({
      teamsBasePath,
      readConfig: async () => null,
    })),
    readConfig: async () => null,
    logger: {
      info: (message) => events.push(message),
      warn: (message) => events.push(`warn:${message}`),
    },
    canDeliverToOpenCodeRuntimeForTeam: () => options.canDeliver,
    canAttemptCommittedOpenCodeSessionRecovery: () => options.canDeliver,
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (team) => cleanups.push(team),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: async () =>
      options.recovered
        ? ({ runtimePid: 4321, sessionId: 'session-1', runtimeAlive: true } as never)
        : null,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () =>
      options.recovered
        ? ({ runtimePid: 4321, sessionId: 'session-1', runtimeAlive: true } as never)
        : null,
    readLaunchState: async () => launchState(),
    ...(options.committedEvidence
      ? { readCommittedBootstrapSessionEvidence: async () => options.committedEvidence! }
      : {}),
  });
  return { recovery, events, cleanups };
}

describe('native OpenCode lane recovery', () => {
  it('restores a lane whose launch record still proves it ran', async () => {
    const { recovery, events } = build({ canDeliver: true, recovered: true });

    await expect(
      recovery.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName,
        laneId,
        member,
        projectPath: '/TEST/alpha',
      })
    ).resolves.toBe(true);
    expect(events.some((event) => event.includes('Recovered OpenCode lane'))).toBe(true);
  });

  it('does not start anything when the runtime refuses to deliver to the team', async () => {
    const { recovery, cleanups, events } = build({ canDeliver: false, recovered: true });

    await expect(
      recovery.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName,
        laneId,
        member,
        projectPath: '/TEST/alpha',
      })
    ).resolves.toBe(false);
    expect(cleanups).toEqual([teamName]);
    expect(events).toEqual([]);
  });

  it('does nothing when the runtime could not revive the lane', async () => {
    const { recovery } = build({ canDeliver: true, recovered: false });

    await expect(
      recovery.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName,
        laneId,
        member,
        projectPath: '/TEST/alpha',
      })
    ).resolves.toBe(false);
  });

  it('revives a lane from a committed bootstrap session and marks it active on disk', async () => {
    const committedEvidence: OpenCodeCommittedBootstrapSessionEvidence = {
      state: 'healthy',
      committed: true,
      activeRunId: 'run-committed',
      sessions: [{ memberName: 'builder', runId: 'run-committed' }],
      diagnostics: [],
    } as never;
    const { recovery } = build({ canDeliver: true, recovered: true, committedEvidence });

    await expect(
      recovery.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery({
        teamName,
        laneId,
        member,
        projectPath: '/TEST/alpha',
      })
    ).resolves.toBe(true);

    const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName);
    expect(laneIndex?.lanes[laneId]?.state).toBe('active');
    await expect(
      createNativeOpenCodeMemberIdentity(identityDeps({ teamsBasePath, readConfig: async () => null }))
        .resolveCurrentOpenCodeRuntimeRunId(teamName, laneId)
    ).resolves.toBe('run-committed');
  });

  it('leaves a degraded lane alone instead of reviving it', async () => {
    const laneIndexWriter = await import(
      '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader'
    );
    await laneIndexWriter.upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath,
      teamName,
      laneId,
      state: 'degraded',
    });
    const committedEvidence = {
      state: 'healthy',
      committed: true,
      activeRunId: 'run-committed',
      sessions: [{ memberName: 'builder', runId: 'run-committed' }],
      diagnostics: [],
    } as never;
    const { recovery } = build({ canDeliver: true, recovered: true, committedEvidence });

    await expect(
      recovery.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery({
        teamName,
        laneId,
        member,
        projectPath: '/TEST/alpha',
      })
    ).resolves.toBe(false);
    const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName);
    expect(laneIndex?.lanes[laneId]?.state).toBe('degraded');
  });
});
