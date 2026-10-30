// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { LifecycleSnapshotFeed } from '../../../../src/features/team-provisioning/core/domain/LifecycleSnapshotFeed';
import { createDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createDesktopTeamRuntime';

import type {
  MemberLifecycleSnapshot,
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';
import type { DesktopTeamRuntimeDependencies } from '../../../../src/features/team-provisioning/main/composition/createDesktopTeamRuntime';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

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
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
    ...overrides,
  };
}

function harness(options: { initial?: TeamLifecycleSnapshot } = {}) {
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
      publish(run, { state: 'preparing', resources: 'preparing', members: {} });
      publish(run, {
        state: 'starting',
        resources: 'held',
        members: Object.fromEntries(
          [member('team-lead', 'connecting')].map((entry) => [entry.memberName, entry])
        ),
      });
      if (request.teamName !== teamName) throw new Error('TEST unexpected team');
      return { run };
    }),
    stop: vi.fn(async () => undefined),
    restartMember: vi.fn(async () => ({ kind: 'already-running' as const })),
    skipMember: vi.fn(async () => undefined),
  };
  const definitions = {
    create: vi.fn(async () => undefined),
    updateLaunchSettings: vi.fn(async () => undefined),
  };
  const history = { findByRunId: vi.fn(async () => undefined) };
  const deps: DesktopTeamRuntimeDependencies = {
    currentContext: () => owner,
    lifecycle: { commands, runs, watch: () => feed },
    definitions,
    progressHistory: history,
    now: () => now,
  };
  return {
    deps,
    run,
    publish,
    commands,
    definitions,
    history,
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

  it('reports an already running team without inventing a new run', async () => {
    const { runtime, publish, run } = harness();
    publish(run, {
      state: 'ready',
      resources: 'held',
      members: Object.fromEntries([member('team-lead', 'ready')].map((e) => [e.memberName, e])),
    });
    const { onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).resolves.toEqual({
      runId: 'TEST-run',
      launchStatus: 'already_running',
      alreadyRunning: true,
    });
  });

  it('reports a pending launch as already launching', async () => {
    const { runtime, publish, run } = harness();
    publish(run, { state: 'preparing', resources: 'preparing', members: {} });
    const { onProgress } = collect();
    await expect(runtime.launchTeam({ teamName, cwd: '/TEST/cwd' }, onProgress)).resolves.toEqual({
      runId: 'TEST-run',
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });
  });

  it('stops the exact observed run and ignores an absent or stopped team', async () => {
    const { runtime, publish, run, commands } = harness();
    publish(run, { state: 'ready', members: { 'team-lead': member('team-lead', 'ready') } });
    await runtime.stopTeam(teamName);
    expect(commands.stop).toHaveBeenCalledWith({
      expectedContext: owner,
      teamName,
      runId: 'TEST-run',
    });
    const empty = harness();
    await empty.runtime.stopTeam('test-absent');
    expect(empty.commands.stop).not.toHaveBeenCalled();
    empty.publish(empty.run, { state: 'stopped', desired: 'stopped', resources: 'released' });
    await empty.runtime.stopTeam(teamName);
    expect(empty.commands.stop).not.toHaveBeenCalled();
  });

  it('cancels only a known running run and rejects unknown or finished ones', async () => {
    const { runtime, publish, run, commands } = harness();
    await expect(runtime.cancelProvisioning('TEST-unknown')).rejects.toThrow('Unknown runId');
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

  it('answers runtime reads from the native registry', async () => {
    const { runtime, publish, run } = harness();
    await expect(runtime.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: false,
      runId: null,
      progress: null,
    });
    publish(run, {
      state: 'ready',
      members: { 'team-lead': member('team-lead', 'ready') },
    });
    await expect(runtime.getRuntimeState(teamName)).resolves.toEqual({
      teamName,
      isAlive: true,
      runId: 'TEST-run',
      progress: null,
    });
    expect(runtime.isTeamAlive(teamName)).toBe(true);
    expect(runtime.getAliveTeams()).toEqual([teamName]);
    expect(runtime.getCurrentRunId(teamName)).toBe('TEST-run');
    expect(runtime.hasProvisioningRun(teamName)).toBe(true);
  });

  it('reads progress from the native run first and persisted history second', async () => {
    const { runtime, publish, run, history } = harness();
    publish(run, { state: 'ready', members: { 'team-lead': member('team-lead', 'ready') } });
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
    const { deps, runtime, publish, run } = harness();
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
  });
});
