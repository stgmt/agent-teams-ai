// @vitest-environment node
import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import {
  createNativeTeamProvisioningRoot,
  type NativeTeamProvisioningRootDependencies,
} from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningRoot';
import { claimTeamForThisProfile, createTeamProfileOwnership } from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

import type { NativeDesktopTeamRuntimeDependencies } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function runtimeDeps(teamsRoot: string): NativeDesktopTeamRuntimeDependencies {
  return {
    owner,
    currentContext: () => owner,
    teamsRoot,
    settings: {
      metadata: { getMeta: async () => null },
      members: { getMeta: async () => null },
    } as never,
    provider: {} as never,
    runtimeRoot: join(teamsRoot, 'runtime'),
    workspaceRoot: teamsRoot,
    mcp: {} as never,
    inbox: {} as never,
    controlUrl: async () => 'http://127.0.0.1:1',
    briefing: async () => 'TEST briefing',
    readStartupTasks: async () => [],
    createController: () => ({
      taskBoard: { deliverStartupWorkAsync: async () => ({ delivered: [], skipped: [] }) },
    }),
    invalidate: () => undefined,
    contextInvalidationSignal: () => new AbortController().signal,
    withExpectedContext: async (_expected, operation) => operation(),
    definitions: {
      create: async () => undefined,
      updateLaunchSettings: async () => undefined,
    },
    profileOwnership: {
      isManagedByThisProfile: async () => true,
      isManagedByThisProfileSync: () => true,
    },
    claimTeam: async () => undefined,
    clearStoppedLaneStopBackoff: () => undefined,
    progressHistory: { findByRunId: async () => undefined },
    listTeamNames: async () => [],
  };
}

function buildDeps(teamsRoot: string): NativeTeamProvisioningRootDependencies {
  return {
    runtimeDeps: runtimeDeps(teamsRoot),
    apisDeps: {
      taskActivity: { repairStaleTaskActivityIntervalsBeforeSnapshot: async () => undefined },
      recipientSources: {
        readConfigSnapshot: async () => null,
        readMembersMeta: async () => [],
      },
      now: () => '2026-11-02T00:00:00.000Z',
    },
    watchdogDeps: {
      teamsBasePath: teamsRoot,
      scheduler: {
        isEnabled: () => false,
        schedule: () => undefined,
        isStaleError: async () => false,
      },
      identity: {} as never,
      ledgers: {} as never,
      proof: {} as never,
      permissions: {} as never,
      pidMemory: {} as never,
      bootstrap: {} as never,
      lanes: { recoverLanesForWatchdog: async () => [] },
      stoppedLanes: { stopLanesForStoppedTeam: async () => 0 },
      readInboxMessages: async () => [],
      canDeliverToTeamRuntime: () => false,
      hasAcceptedMemberWorkSyncReport: async () => false,
      hasAcknowledgedInbound: async () => false,
      logPromptDeliveryEvent: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      nowIso: () => '2026-11-02T00:00:00.000Z',
      sleep: async () => undefined,
      getErrorMessage: (error) => String(error),
    },
    prepDeps: {
      provider: { environment: async () => ({}), executable: async () => '' } as never,
      runtimeAdapterRegistry: { has: () => false, get: () => undefined } as never,
      logger: { info: () => undefined, warn: () => undefined },
    },
    languageDeps: {
      readConfig: async () => null,
      writeLanguage: async () => undefined,
      getSystemLocale: () => 'en',
      resolveLanguageName: (code) => code,
      logger: { info: () => undefined, warn: () => undefined },
    },
    busyStatus: { getBusyStatus: async () => ({ busy: false }) as never },
    inboxRelay: {
      relayOpenCodeMemberInboxMessages: async () => ({ diagnostics: [], delivered: 0 }) as never,
    },
  };
}

function setup() {
  const teamsRoot = mkdtempSync(join(tmpdir(), 'native-root-test-'));
  directories.push(teamsRoot);
  mkdirSync(teamsRoot, { recursive: true });

  const deps = buildDeps(teamsRoot);
  const nativeRuntime = createNativeDesktopTeamRuntime(deps.runtimeDeps);
  const root = createNativeTeamProvisioningRoot({ ...deps, nativeRuntime });
  return { root, nativeRuntime, teamsRoot };
}

describe('native team provisioning root', () => {
  it('answers both ownership checks from the same real profile marker', async () => {
    const teamsRoot = mkdtempSync(join(tmpdir(), 'native-profile-root-'));
    directories.push(teamsRoot);
    mkdirSync(join(teamsRoot, 'own-team'));
    mkdirSync(join(teamsRoot, 'foreign-team'));
    await claimTeamForThisProfile({
      teamsBasePath: teamsRoot, teamName: 'own-team', reason: 'create', profileScope: 'own',
    });
    await claimTeamForThisProfile({
      teamsBasePath: teamsRoot, teamName: 'foreign-team', reason: 'create', profileScope: 'foreign',
    });
    const deps = buildDeps(teamsRoot);
    deps.runtimeDeps.profileOwnership = createTeamProfileOwnership({
      isTrackedInThisProcess: () => false,
      getTeamsBasePath: () => teamsRoot,
      getProfileScope: () => 'own',
    });
    const root = createNativeTeamProvisioningRoot(deps);
    await expect(root.isTeamManagedByThisProfile('own-team')).resolves.toBe(true);
    await expect(root.isTeamManagedByThisProfile('foreign-team')).resolves.toBe(false);
    expect(root.isTeamManagedByThisProfileSync('own-team')).toBe(true);
    expect(root.isTeamManagedByThisProfileSync('foreign-team')).toBe(false);
  });

  it('reports a team with no run as not alive and with no active runtimes', () => {
    const { root } = setup();
    expect(root.isTeamAlive('test-team')).toBe(false);
    expect(root.getAliveTeams()).toEqual([]);
    expect(root.getAliveTeamNames()).toEqual([]);
    expect(root.hasActiveTeamRuntimes()).toBe(false);
    expect(root.getCurrentRunId('test-team')).toBeNull();
  });

  it('reflects an alive run in getAliveTeamNames and hasActiveTeamRuntimes', () => {
    const { root, nativeRuntime } = setup();
    const identity = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
    const registry = nativeRuntime.registry;
    registry.configureTeam(identity, [{ memberName: 'team-lead', role: 'lead' }]);
    const [token] = registry.beginTeamStart(identity, () => 'TEST-operation');
    expect(token).toBeDefined();
    registry.observeSpawn(token, { pid: process.pid, birthId: 'TEST-birth' });

    expect(root.getAliveTeamNames()).toEqual(['test-team']);
    expect(root.getAliveTeams()).toEqual(['test-team']);
    expect(root.hasActiveTeamRuntimes()).toBe(true);
    expect(root.isTeamAlive('test-team')).toBe(true);
    expect(root.getCurrentRunId('test-team')).toBe('TEST-run');
    expect(root.isTeamAlive('other-team')).toBe(false);
  });

  it('answers a runtime snapshot for a team with no run', async () => {
    const { root } = setup();
    await expect(root.getTeamAgentRuntimeSnapshot('test-team')).resolves.toMatchObject({
      teamName: 'test-team',
      runId: null,
      members: {},
    });
  });

  it('answers member spawn statuses for a team with no run', async () => {
    const { root } = setup();
    await expect(root.getMemberSpawnStatuses('test-team')).resolves.toMatchObject({
      statuses: {},
      runId: null,
    });
  });

  it('runs a watchdog pass without throwing on an empty team set', async () => {
    const { root } = setup();
    await expect(root.scanOpenCodePromptDeliveryWatchdog('test-team')).resolves.toBeUndefined();
  });
});
