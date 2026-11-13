import {
  createNodeMemberRuntimeFixture,
  rejectUnexpectedRecovery,
} from './nodeMemberRuntimeFixture';
// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBoundTeamLiveStatusQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundTeamLiveStatusQueries';
import { createNativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import { NodeTeamLaunchSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamLaunchSettings';
import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';
import { createOpenCodePromptDeliveryLedger } from '../../../../src/main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import {
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { inspectProcessesByPid } from '../../../../src/main/utils/processInspection';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import type { OwnedMemberProcess } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

import type {
  NativeDesktopTeamRuntime,
  NativeDesktopTeamRuntimeDependencies,
} from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';

const owner = {
  appInstanceId: 'TEST-new-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 2,
};
const previousRun = {
  ...owner,
  appInstanceId: 'TEST-killed-app',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-surviving-run',
};
const directories: string[] = [];
const children: ChildProcess[] = [];
const sdkChildren: OwnedMemberProcess[] = [];
const runtimes: NativeDesktopTeamRuntime[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  // Only fixture-owned processes are terminated; never shared agents or services.
  for (const child of sdkChildren.splice(0)) await child.stop();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await expect
        .poll(
          () => {
            const members = runtime.lifecycle.runs.find('test-team')?.members ?? {};
            return Object.values(members).some(
              (member) =>
                member.process !== null ||
                (member.process === null && member.lane === null && member.resources !== 'released')
            );
          },
          { timeout: 20_000 }
        )
        .toBe(false);
      await runtime.lifecycle.shutdown();
    })
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
}, 30_000);

async function liveChild() {
  const child = spawn(
    process.execPath,
    ['-e', 'process.send("ready"); setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  children.push(child);
  await once(child, 'message');
  if (!child.pid) throw new Error('Fixture process did not receive a PID');
  return child.pid;
}

async function setup(providerId = 'anthropic') {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-live-recovery-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  await mkdir(join(teamsRoot, 'test-team'), { recursive: true });
  const store = new NativeTeamConfigStore(teamsRoot);
  const specEnvironment = {
    OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
    OMP_SPEC_REGISTRY_TOKEN: 'TEST-fixture-credential',
  };
  const settings: NativeDesktopTeamRuntimeDependencies['settings'] = {
    metadata: {
      getMeta: async () => ({
        version: 1,
        runtimeSelectionVersion: 1,
        providerId,
        cwd: root,
        createdAt: 1,
        specScope: { projects: ['TEST/project'], bindings: [] },
      }),
    },
    members: { getMeta: async () => ({ version: 1, members: [] }) },
    specRegistryEnvironment: async () => specEnvironment,
  } as never;
  const priorSettings = new NodeTeamLaunchSettings({ ...settings, teamsRoot });
  const captured = await priorSettings.capture(previousRun);
  priorSettings.release(previousRun);
  const sdk = await createNodeMemberRuntimeFixture();
  const token = {
    ...previousRun,
    memberName: 'team-lead',
    generation: 3,
    operationId: 'TEST-surviving-operation',
  };
  let sdkChild: OwnedMemberProcess | null = null;
  if (providerId !== 'opencode') {
    const native = new NodeMemberRuntime(
      {
        prepare: (_settings, attempt) =>
          sdk.plan(
            `await send({ type: 'system', subtype: 'team_bootstrap', team_name: ${JSON.stringify(previousRun.teamName)},
          run_id: ${JSON.stringify(previousRun.runId)}, event: 'completed', status: 'completed',
          expected_members: [], registered_members: [], failed_members: [] });`,
            attempt,
            { cwd: root }
          ),
        recover: rejectUnexpectedRecovery,
      },
      (_attempt, operation) => operation()
    );
    sdkChild = await native.spawn(
      {
        team: previousRun,
        memberName: 'team-lead',
        role: 'lead',
        configurationRevision: captured.configurationRevision,
        providerId,
        model: null,
        workingDirectory: root,
        instructions: 'TEST recovery',
        specIntegration: {
          scope: { projects: ['TEST/project'], bindings: [] },
          environment: specEnvironment,
        },
      },
      token,
      new AbortController().signal
    );
    sdkChildren.push(sdkChild);
    const identity = sdkChild.identity;
    await expect
      .poll(() => sdk.host.hasAuthenticatedConnection(token, identity), { timeout: 20_000 })
      .toBe(true);
    // A socket is not evidence: the survivor's bootstrap must be durably consumed before the
    // host is replaced, because the new instance replays ledger receipts, not live sockets.
    await expect
      .poll(
        () =>
          sdk.observed.filter(
            (event) => event.type === 'system' && event.subtype === 'team_bootstrap'
          ).length,
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);
    // Reopen the durable ledger and original endpoint while the same child survives.
    await sdk.replaceHost();
  }
  const pid = sdkChild?.identity.pid ?? (await liveChild());
  const processIdentity = (await inspectProcessesByPid([pid])).get(pid);
  if (processIdentity?.status !== 'found' || typeof processIdentity.startedAt !== 'number')
    throw new Error('Fixture process birth could not be established by the OS');
  const member = {
    name: 'team-lead',
    agentId: 'team-lead@test-team',
    providerId,
    provider: providerId,
    cwd: root,
    backendType: 'process',
    runtimePid: pid,
    runtimeStartedAt: processIdentity.startedAt,
    runtimeProcessBirthId: sdkChild?.identity.birthId ?? 'TEST-surviving-birth',
    runtimeGeneration: 3,
    runtimeOperationId: 'TEST-surviving-operation',
    ...(providerId === 'opencode' ? { runtimeSessionId: 'TEST-surviving-session' } : {}),
  };
  await store.mutate('test-team', new AbortController().signal, async () => ({
    name: 'test-team',
    leadAgentId: member.agentId,
    members: [member],
    appManagedRun: { identity: previousRun, configurationRevision: captured.configurationRevision },
  }));
  await claimTeamForThisProfile({
    teamsBasePath: teamsRoot,
    teamName: 'test-team',
    reason: 'create',
    profileScope: 'TEST-profile',
  });
  const launch = vi.fn(async () => {
    throw new Error('Recovery must not launch another runtime');
  });
  const sendMessage = vi.fn(async () => undefined);
  const readStartupTasks = vi.fn(async () => []);
  const deliverStartupWorkAsync = vi.fn(async () => ({ delivered: [], skipped: [] }));
  const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
    relayed: 0,
    attempted: 0,
    delivered: 0,
    failed: 0,
  }));
  const getOpenCodeRuntimeDeliveryStatus = vi.fn(async () => ({
    responsePending: true,
    ledgerStatus: 'accepted',
  }));
  const adapter = {
    launch,
    stop: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => ({
      runId: previousRun.runId,
      teamName: 'test-team',
      providerId: 'opencode',
      teamLaunchState: 'ready',
      snapshot: null,
      warnings: [],
      diagnostics: [],
      members: {
        'team-lead': {
          memberName: 'team-lead',
          providerId: 'opencode',
          runtimePid: pid,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          sessionId: 'TEST-surviving-session',
          launchState: 'ready',
        },
      },
    })),
  };
  const dependencies: NativeDesktopTeamRuntimeDependencies = {
    owner,
    currentContext: () => owner,
    teamsRoot,
    runtimeRoot: join(root, 'runtime'),
    workspaceRoot: root,
    sdkHost: sdk.host,
    settings,
    provider: {} as never,
    mcp: {
      writeConfigFile: async () => {
        throw new Error('Recovery must not prepare a new MCP configuration');
      },
      removeConfigFile: async (path) => {
        await rm(path, { force: true });
      },
    },
    inbox: { sendMessage } as never,
    controlUrl: async () => 'http://127.0.0.1:1',
    briefing: async () => 'TEST briefing',
    readStartupTasks,
    createController: () => ({ taskBoard: { deliverStartupWorkAsync } }),
    invalidate: () => undefined,
    contextInvalidationSignal: () => new AbortController().signal,
    withExpectedContext: async (_expected, operation) => operation(),
    definitions: { create: async () => undefined, updateLaunchSettings: async () => undefined },
    profileOwnership: createTeamProfileOwnership({
      isTrackedInThisProcess: () => false,
      getTeamsBasePath: () => teamsRoot,
      getProfileScope: () => 'TEST-profile',
    }),
    claimTeam: async () => undefined,
    clearStoppedLaneStopBackoff: () => undefined,
    listTeamNames: async () => ['test-team', 'foreign-team'],
    runtimeAdapterRegistry: { has: (id: string) => id === 'opencode', get: () => adapter } as never,
    openCodeMemberDelivery: {
      relayOpenCodeMemberInboxMessages,
      getOpenCodeRuntimeDeliveryStatus,
    } as never,
  };
  const runtime = createNativeDesktopTeamRuntime(dependencies);
  runtimes.push(runtime);
  const statuses = createBoundTeamLiveStatusQueries({
    owner,
    queries: runtime.lifecycle.queries,
    now: () => new Date().toISOString(),
  });
  return {
    runtime,
    statuses,
    store,
    teamsRoot,
    pid,
    member,
    launch,
    sendMessage,
    readStartupTasks,
    deliverStartupWorkAsync,
    relayOpenCodeMemberInboxMessages,
    getOpenCodeRuntimeDeliveryStatus,
  };
}

describe('native recovery in a fresh app runtime', () => {
  it('adopts surviving exact process identities into public live projections without relaunch or startup redelivery', async () => {
    const fixture = await setup();
    const { runtime, statuses, pid } = fixture;
    await expect(runtime.recoverStartup()).resolves.toMatchObject({ failed: [] });
    expect(await statuses.runtimeSnapshot({ teamName: 'test-team' })).toMatchObject({
      runId: previousRun.runId,
      members: { 'team-lead': { alive: true, pid, runtimePid: pid } },
    });
    await expect
      .poll(() => runtime.lifecycle.runs.find('test-team')?.members['team-lead']?.phase, {
        timeout: 20_000,
      })
      .toBe('ready');
    expect(runtime.lifecycle.runs.find('test-team')).toMatchObject({
      members: {
        'team-lead': {
          phase: 'ready',
          everConnected: true,
          generation: 3,
          operationId: 'TEST-surviving-operation',
          process: { pid, birthId: fixture.member.runtimeProcessBirthId },
        },
      },
    });
    await runtime.recoverStartup();
    expect(await statuses.runtimeSnapshot({ teamName: 'test-team' })).toMatchObject({
      runId: previousRun.runId,
      members: { 'team-lead': { alive: true, pid } },
    });
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(fixture.sendMessage).not.toHaveBeenCalled();
    expect(fixture.readStartupTasks).not.toHaveBeenCalled();
    expect(fixture.deliverStartupWorkAsync).not.toHaveBeenCalled();
    // Recovery runs several real PID/birth authority probes, each a PowerShell start (0.6-2 s
    // idle, several seconds on a loaded host). This budget covers that platform cost; it cannot
    // hide a stuck path because readiness above is awaited as a signal, not slept on.
  }, 60_000);

  it('does not adopt foreign-profile rows, dead PIDs, or a live PID from an earlier process birth', async () => {
    const { runtime, statuses, store, teamsRoot, member, pid } = await setup();
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(dead, 'exit');
    expect(dead.pid).toBeGreaterThan(0);
    await store.mutate('test-team', new AbortController().signal, async (current) => ({
      ...current,
      members: [
        member,
        {
          ...member,
          name: 'dead-worker',
          agentId: 'dead-worker@test-team',
          runtimePid: dead.pid,
          runtimeProcessBirthId: 'TEST-dead-birth',
        },
        {
          ...member,
          name: 'reused-worker',
          agentId: 'reused-worker@test-team',
          runtimePid: process.pid,
          runtimeStartedAt: Date.now() + 600_000,
          runtimeProcessBirthId: 'TEST-obsolete-birth',
        },
        {
          ...member,
          name: 'later-reused-worker',
          agentId: 'later-reused-worker@test-team',
          runtimeStartedAt: member.runtimeStartedAt - 600_000,
          runtimeProcessBirthId: 'TEST-older-process-birth',
        },
      ],
    }));
    await mkdir(join(teamsRoot, 'foreign-team'));
    await store.mutate('foreign-team', new AbortController().signal, async () => ({
      name: 'foreign-team',
      leadAgentId: 'team-lead@foreign-team',
      members: [{ ...member, agentId: 'team-lead@foreign-team' }],
      appManagedRun: {
        identity: {
          ...previousRun,
          teamName: 'foreign-team',
          dataRootFingerprint: 'TEST-foreign-root',
        },
        configurationRevision: 'TEST-foreign-revision',
      },
    }));
    await claimTeamForThisProfile({
      teamsBasePath: teamsRoot,
      teamName: 'foreign-team',
      reason: 'create',
      profileScope: 'TEST-foreign-profile',
    });
    const foreignPath = join(teamsRoot, 'foreign-team', 'config.json');
    const foreignBefore = await readFile(foreignPath, 'utf8');
    await runtime.recoverStartup();
    const projection = await statuses.runtimeSnapshot({ teamName: 'test-team' });
    expect(projection.members['team-lead']).toMatchObject({ alive: true, pid });
    for (const name of ['dead-worker', 'reused-worker', 'later-reused-worker']) {
      expect(projection.members[name]?.alive ?? false).toBe(false);
      expect(projection.members[name]?.runtimePid).toBeUndefined();
    }
    expect((await statuses.runtimeSnapshot({ teamName: 'foreign-team' })).members).toEqual({});
    expect(await readFile(foreignPath, 'utf8')).toBe(foreignBefore);
    // Same real Windows PID/birth probe cost as the adoption case: four roster rows are
    // inspected through PowerShell before adoption is decided.
  }, 60_000);

  it('reopens accepted durable lane work and resumes observation without launching or submitting it again', async () => {
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG', '1');
    const fixture = await setup('opencode');
    const scope = { teamsBasePath: fixture.teamsRoot, teamName: 'test-team', laneId: 'primary' };
    await setOpenCodeRuntimeActiveRunManifest({ ...scope, runId: previousRun.runId });
    await upsertOpenCodeRuntimeLaneIndexEntry({ ...scope, state: 'active' });
    const ledger = createOpenCodePromptDeliveryLedger('test-team', 'primary', scope);
    const beforeCrash = new Date(Date.now() - 60_000).toISOString();
    const pending = await ledger.ensurePending({
      teamName: 'test-team',
      memberName: 'team-lead',
      laneId: 'primary',
      runId: previousRun.runId,
      inboxMessageId: 'TEST-inflight-message',
      inboxTimestamp: beforeCrash,
      source: 'watcher',
      replyRecipient: 'user',
      payloadHash: 'TEST-payload',
      now: beforeCrash,
    });
    const accepted = await ledger.applyDeliveryResult({
      id: pending.id,
      accepted: true,
      runtimePromptMessageId: 'TEST-already-submitted-prompt',
      sessionId: 'TEST-surviving-session',
      deliveryAttemptId: 'TEST-original-attempt',
      now: beforeCrash,
    });
    await ledger.markNextAttemptDeferred({
      id: accepted.id,
      nextAttemptAt: beforeCrash,
      deferredAt: beforeCrash,
    });
    // The runtime has never launched: only the pre-crash config, manifest and ledger exist.
    // Fake only scheduling: filesystem and process-inspection completion remain real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await fixture.runtime.recoverStartup();
      await vi.advanceTimersByTimeAsync(16_000);
      await expect
        .poll(() => fixture.getOpenCodeRuntimeDeliveryStatus.mock.calls)
        .toContainEqual(['test-team', 'TEST-inflight-message']);
      const reopened = createOpenCodePromptDeliveryLedger('test-team', 'primary', scope);
      expect(
        await reopened.getByInboxMessage({
          teamName: 'test-team',
          memberName: 'team-lead',
          laneId: 'primary',
          inboxMessageId: 'TEST-inflight-message',
        })
      ).toMatchObject({
        id: accepted.id,
        runId: previousRun.runId,
        status: 'accepted',
        attempts: accepted.attempts,
        runtimePromptMessageId: 'TEST-already-submitted-prompt',
        runtimeSessionId: 'TEST-surviving-session',
      });
      expect(fixture.launch).not.toHaveBeenCalled();
      expect(fixture.relayOpenCodeMemberInboxMessages).not.toHaveBeenCalled();
      expect(fixture.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
