// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LifecycleSnapshotFeed } from '../../../../src/features/team-provisioning/core/domain/LifecycleSnapshotFeed';
import { TeamDefinitionExistsError } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamDefinitionStore';
import { createDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createDesktopTeamRuntime';

import type {
  MemberLifecycleSnapshot,
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';
import type { DesktopTeamRuntimeDependencies } from '../../../../src/features/team-provisioning/main/composition/createDesktopTeamRuntime';
import type { TeamProvisioningProgress, TeamRuntimeState } from '../../../../src/shared/types';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const teamName = 'test-team';
const startedAt = '2026-10-30T00:00:00.000Z';
const now = '2026-10-30T00:00:05.000Z';

function member(
  memberName: string,
  phase: MemberLifecycleSnapshot['phase'],
  overrides: Partial<MemberLifecycleSnapshot> = {}
): MemberLifecycleSnapshot {
  return {
    memberName,
    role: memberName === 'team-lead' ? 'lead' : 'member',
    membership: 'configured',
    desired: 'running',
    phase,
    resources: 'held',
    generation: 1,
    operationId: `op-${memberName}`,
    process: phase === 'ready' ? { pid: 321, birthId: 'birth' } : null,
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
    ...overrides,
  };
}

const lead = (): MemberLifecycleSnapshot => member('team-lead', 'ready');

function harness(
  options: { initial?: TeamLifecycleSnapshot } & Pick<DesktopTeamRuntimeDependencies, 'launchAdmission'> = {}
) {
  let version = 0;
  let current: TeamLifecycleSnapshot | null = options.initial ?? null;
  const feed = new LifecycleSnapshotFeed(() => {});
  const publish = (
    run: TeamRunIdentity,
    patch: Partial<TeamLifecycleSnapshot> & Pick<TeamLifecycleSnapshot, 'state'>
  ): void => {
    version += 1;
    current = {
      identity: run,
      desired: 'running',
      resources: 'held',
      error: null,
      startedAt,
      version,
      members: {},
      ...patch,
    };
    feed.publish(current);
  };
  const run: TeamRunIdentity = { ...owner, teamName, runId: 'TEST-run' };
  const hasProcess = (): boolean =>
    (current ? Object.values(current.members) : []).some(
      (entry) => entry.membership === 'configured' && entry.process !== null
    );
  const runs = {
    find: (name: string) => (current?.identity.teamName === name ? current : null),
    findByRunId: (runId: string) => (current?.identity.runId === runId ? current : null),
    hasRun: (identity: TeamRunIdentity) => current?.identity.runId === identity.runId,
    isLive: () => current?.desired === 'running',
    aliveTeamNames: () => (hasProcess() ? [teamName] : []),
    aliveRunId: (name: string) =>
      hasProcess() && current?.identity.teamName === name ? current.identity.runId : null,
  };
  const commands = {
    launch: vi.fn(async (input: unknown) => {
      const request = input as { teamName: string };
      if (request.teamName !== teamName) throw new Error('TEST unexpected team');
      if (current?.desired === 'running' && current.state !== 'failed')
        return { run: current.identity };
      publish(run, { state: 'preparing', resources: 'preparing', members: {} });
      publish(run, {
        state: 'starting',
        resources: 'held',
        members: { 'team-lead': member('team-lead', 'connecting') },
      });
      return { run };
    }),
    stop: vi.fn(async () => {
      if (current)
        publish(current.identity, { state: 'stopped', desired: 'stopped', resources: 'released' });
    }),
    restartMember: vi.fn(async () => ({ kind: 'already-running' as const })),
    skipMember: vi.fn(async () => undefined),
  };
  const definitions = {
    create: vi.fn(async () => undefined),
    updateLaunchSettings: vi.fn(async () => undefined),
  };
  const history = { findByRunId: vi.fn(async () => undefined) };
  const bootstrapRuntime = {
    read: vi.fn(async (): Promise<TeamRuntimeState | null> => null),
  };
  const deps: DesktopTeamRuntimeDependencies = {
    currentContext: () => owner,
    lifecycle: { commands, runs, watch: () => feed },
    definitions,
    progressHistory: history,
    bootstrapRuntime,
    ...(options.launchAdmission ? { launchAdmission: options.launchAdmission } : {}),
    now: () => now,
  };
  return {
    deps,
    feed,
    run,
    publish,
    commands,
    definitions,
    history,
    bootstrapRuntime,
    runtime: createDesktopTeamRuntime(deps),
  };
}

function collect(): {
  onProgress: (progress: TeamProvisioningProgress) => void;
  progress: TeamProvisioningProgress[];
} {
  const progress: TeamProvisioningProgress[] = [];
  return { progress, onProgress: (entry) => progress.push(entry) };
}

describe('desktop team runtime over the native lifecycle', () => {
  it('launches a saved definition and streams progress for the admitted run', async () => {
    const { runtime, definitions, commands } = harness();
    const { progress, onProgress } = collect();
    await expect(
      runtime.launchTeam({ teamName, cwd: '/TEST/cwd', model: 'TEST-model' }, onProgress)
    ).resolves.toEqual({ runId: 'TEST-run', launchStatus: 'started' });
    expect(definitions.updateLaunchSettings).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ cwd: '/TEST/cwd', model: 'TEST-model' }),
      expect.any(AbortSignal)
    );
    expect(commands.launch).toHaveBeenCalledWith({ expectedContext: owner, teamName });
    await expect
      .poll(() => progress.map((entry) => entry.state))
      .toEqual(['configuring', 'spawning']);
    expect(progress.every((entry) => entry.runId === 'TEST-run')).toBe(true);
  });

  it('creates a canonical definition and then launches it', async () => {
    const { runtime, definitions } = harness();
    const { onProgress } = collect();
    const request = {
      teamName,
      cwd: '/TEST/cwd',
      providerId: 'anthropic' as const,
      members: [{ name: 'builder', role: 'Builder' }],
    };
    await expect(runtime.createTeam(request, onProgress)).resolves.toMatchObject({
      runId: 'TEST-run',
    });
    expect(definitions.create).toHaveBeenCalledWith(request, expect.any(AbortSignal));
    expect(definitions.updateLaunchSettings).not.toHaveBeenCalled();
  });

  it('reuses a metadata-only draft instead of failing creation', async () => {
    const { runtime, definitions } = harness();
    definitions.create.mockRejectedValueOnce(new TeamDefinitionExistsError(teamName));
    const request = {
      teamName,
      cwd: '/TEST/cwd',
      providerId: 'anthropic' as const,
      members: [{ name: 'builder', role: 'Builder' }],
    };
    await expect(runtime.createTeam(request, collect().onProgress)).resolves.toMatchObject({
      runId: 'TEST-run',
    });
    expect(definitions.updateLaunchSettings).toHaveBeenCalledWith(
      teamName,
      expect.objectContaining({ cwd: '/TEST/cwd' }),
      expect.any(AbortSignal)
    );
  });

  it('does not rewrite a live definition when the team is already running', async () => {
    const { runtime, publish, run, definitions, feed } = harness();
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    const { progress, onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).resolves.toEqual({
      runId: 'TEST-run',
      launchStatus: 'already_running',
      alreadyRunning: true,
    });
    expect(definitions.updateLaunchSettings).not.toHaveBeenCalled();
    await expect.poll(() => progress.map((entry) => entry.state)).toEqual(['ready']);
    // The admitted run is already terminal, so the progress feed must detach.
    await expect(feed.next()).resolves.toMatchObject({ done: true });
  });

  it('reports an already running lane team as already_running', async () => {
    const { runtime, publish, run, definitions, feed } = harness();
    publish(run, {
      state: 'ready',
      members: {
        'team-lead': member('team-lead', 'ready', {
          process: null,
          lane: {
            laneId: 'TEST-lane',
            sessionId: 'TEST-session',
            hostPid: 900,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            permissionBlocked: false,
          },
        }),
      },
    });
    const { progress, onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).resolves.toEqual({
      runId: 'TEST-run',
      launchStatus: 'already_running',
      alreadyRunning: true,
    });
    expect(definitions.updateLaunchSettings).not.toHaveBeenCalled();
    await expect.poll(() => progress.map((entry) => entry.state)).toEqual(['ready']);
    await expect(feed.next()).resolves.toMatchObject({ done: true });
  });

  it('keeps streaming an already launching run until it becomes terminal', async () => {
    const { runtime, publish, run, feed } = harness();
    publish(run, { state: 'preparing', resources: 'preparing', members: {} });
    const { progress, onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).resolves.toEqual({
      runId: 'TEST-run',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });
    await expect.poll(() => progress.map((entry) => entry.state)).toEqual(['configuring']);
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    await expect.poll(() => progress.map((entry) => entry.state)).toEqual(['configuring', 'ready']);
    await expect(feed.next()).resolves.toMatchObject({ done: true });
  });

  it('stops a failed run before admitting a relaunch', async () => {
    const { runtime, publish, run, commands, definitions } = harness();
    publish(run, {
      state: 'failed',
      resources: 'held',
      error: 'TEST failure',
      members: { 'team-lead': member('team-lead', 'failed', { error: 'TEST failure' }) },
    });
    await expect(
      runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, collect().onProgress)
    ).resolves.toMatchObject({ launchStatus: 'started' });
    expect(commands.stop).toHaveBeenCalledWith({
      expectedContext: owner,
      teamName,
      runId: 'TEST-run',
    });
    expect(definitions.updateLaunchSettings).toHaveBeenCalled();
    expect(commands.launch).toHaveBeenCalledTimes(1);
  });

  it('stops the exact observed run and retries a failed release', async () => {
    const { runtime, publish, run, commands } = harness();
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    await runtime.stopTeam(teamName);
    expect(commands.stop).toHaveBeenCalledWith({
      expectedContext: owner,
      teamName,
      runId: 'TEST-run',
    });
    const empty = harness();
    await empty.runtime.stopTeam('test-absent');
    expect(empty.commands.stop).not.toHaveBeenCalled();
    const stopped = harness();
    stopped.publish(stopped.run, { state: 'stopped', desired: 'stopped', resources: 'released' });
    await stopped.runtime.stopTeam(teamName);
    expect(stopped.commands.stop).not.toHaveBeenCalled();
    const failedRelease = harness();
    failedRelease.publish(failedRelease.run, {
      state: 'release-failed',
      desired: 'stopped',
      resources: 'release-failed',
      error: 'TEST release',
    });
    await failedRelease.runtime.stopTeam(teamName);
    expect(failedRelease.commands.stop).toHaveBeenCalledWith({
      expectedContext: owner,
      teamName,
      runId: 'TEST-run',
    });
  });

  it('cancels only a provisioning run and rejects unknown, ready or stopped ones', async () => {
    const { runtime, publish, run, commands } = harness();
    await expect(runtime.cancelProvisioning('TEST-unknown')).rejects.toThrow('Unknown runId');
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    await expect(runtime.cancelProvisioning('TEST-run')).rejects.toThrow(
      'cannot be cancelled in current state'
    );
    publish(run, { state: 'preparing', resources: 'preparing', members: {} });
    await runtime.cancelProvisioning('TEST-run');
    expect(commands.stop).toHaveBeenCalledWith({
      expectedContext: owner,
      teamName,
      runId: 'TEST-run',
    });
    publish(run, { state: 'stopped', desired: 'stopped', resources: 'released' });
    await expect(runtime.cancelProvisioning('TEST-run')).rejects.toThrow(
      'cannot be cancelled in current state'
    );
  });

  it('answers runtime reads from the native registry and fills progress', async () => {
    const { runtime, publish, run, bootstrapRuntime } = harness();
    await expect(runtime.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
    bootstrapRuntime.read.mockResolvedValueOnce({
      teamName,
      isAlive: true,
      runId: 'TEST-persisted',
      progress: null,
    });
    await expect(runtime.getRuntimeState(teamName)).resolves.toMatchObject({
      runId: 'TEST-persisted',
    });
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    await expect(runtime.getRuntimeState(teamName)).resolves.toMatchObject({
      teamName,
      isAlive: true,
      runId: 'TEST-run',
      progress: { state: 'ready', startedAt },
    });
    expect(runtime.isTeamAlive(teamName)).toBe(true);
    expect(runtime.getAliveTeams()).toEqual([teamName]);
    expect(runtime.getCurrentRunId(teamName)).toBe('TEST-run');
    expect(runtime.hasProvisioningRun(teamName)).toBe(false);
    publish(run, { state: 'preparing', resources: 'preparing', members: {} });
    expect(runtime.hasProvisioningRun(teamName)).toBe(true);
    publish(run, { state: 'stopped', desired: 'stopped', resources: 'released' });
    await expect(runtime.getRuntimeState(teamName)).resolves.toMatchObject({
      runId: null,
      progress: null,
    });
  });

  it('reads progress from the native run first and persisted history second', async () => {
    const { runtime, publish, run, history } = harness();
    publish(run, { state: 'ready', members: { 'team-lead': lead() } });
    await expect(runtime.findByRunId('TEST-run')).resolves.toMatchObject({
      runId: 'TEST-run',
      state: 'ready',
      startedAt,
    });
    expect(history.findByRunId).not.toHaveBeenCalled();
    history.findByRunId.mockResolvedValueOnce({ runId: 'TEST-old' } as never);
    await expect(runtime.findByRunId('TEST-old')).resolves.toMatchObject({ runId: 'TEST-old' });
  });

  it('reports a failed launch and closes the progress feed', async () => {
    const { deps, runtime, publish, run, feed } = harness();
    deps.lifecycle.commands.launch = vi.fn(async () => {
      publish(run, { state: 'preparing', resources: 'preparing', members: {} });
      publish(run, {
        state: 'failed',
        resources: 'released',
        error: 'TEST launch failed',
        members: {},
      });
      throw new Error('TEST launch failed');
    });
    const { progress, onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).rejects.toThrow(
      'TEST launch failed'
    );
    await expect
      .poll(() => progress.map((entry) => entry.state))
      .toEqual(['configuring', 'failed']);
    expect(progress.at(-1)).toMatchObject({
      error: 'TEST launch failed',
      messageSeverity: 'error',
    });
    await expect(feed.next()).resolves.toMatchObject({ done: true });
  });
});

describe('launch admission across features', () => {
  it('refuses a launch the shared guard denies and leaves nothing pending', async () => {
    const assertAdmitted = vi.fn(() => {
      throw new Error('TEST admission refused');
    });
    const { runtime, commands } = harness({ launchAdmission: { assertAdmitted } });
    const { onProgress } = collect();

    await expect(
      runtime.launchTeam({ teamName, cwd: '/TEST/cwd', model: 'TEST-model' }, onProgress)
    ).rejects.toThrow('TEST admission refused');
    expect(assertAdmitted).toHaveBeenCalledTimes(1);
    expect(commands.launch).not.toHaveBeenCalled();
    expect(runtime.pendingLaunchAdmissions()).toBe(0);
  });

  it('counts a live admission until the launch settles, so the bridge stays up', async () => {
    const assertAdmitted = vi.fn();
    const { runtime, commands } = harness({ launchAdmission: { assertAdmitted } });
    const release = deferred();
    const launch = commands.launch.getMockImplementation()!;
    commands.launch.mockImplementation(async (input) => {
      await release.promise;
      return await launch(input);
    });
    const { onProgress } = collect();

    const pending = runtime.launchTeam(
      { teamName, cwd: '/TEST/cwd', model: 'TEST-model' },
      onProgress
    );
    await vi.waitFor(() => expect(runtime.pendingLaunchAdmissions()).toBe(1));

    release.resolve();
    await pending;
    expect(assertAdmitted).toHaveBeenCalledTimes(1);
    expect(runtime.pendingLaunchAdmissions()).toBe(0);
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
