// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeOpenCodeLaneRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeLaneRuntime';

import type { MemberProcessToken } from '../../../../src/features/team-provisioning/contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaneGroupEvents,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '../../../../src/main/services/team/runtime';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};

const token = (memberName: string): MemberProcessToken => ({
  ...run,
  memberName,
  generation: 1,
  operationId: `op-${memberName}`,
});

const settings = (memberName: string, role: 'lead' | 'member'): ConfiguredMemberLaunch => ({
  team: run,
  memberName,
  configurationRevision: 'TEST-revision',
  providerId: 'opencode',
  model: 'TEST-model',
  effort: 'high',
  role,
  workingDirectory: '/TEST/cwd',
  instructions: role === 'lead' ? 'TEST lead prompt' : 'TEST member workflow',
  skipPermissions: true,
  specIntegration: {
    scope: { projects: ['TEST/project'], bindings: [] },
    environment: {
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
    },
  },
});

const evidence = (
  memberName: string,
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence => ({
  memberName,
  providerId: 'opencode',
  launchState: 'confirmed_alive',
  agentToolAccepted: true,
  runtimeAlive: true,
  bootstrapConfirmed: true,
  hardFailure: false,
  diagnostics: [],
  ...overrides,
});

function setup() {
  const launch = vi.fn(
    async (input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> => ({
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'active' as const,
      teamLaunchState: 'clean_success' as const,
      members: {
        'team-lead': evidence('team-lead', { sessionId: 'TEST-session', runtimePid: 900 }),
        builder: evidence('builder', {
          bootstrapConfirmed: false,
          pendingPermissionRequestIds: ['TEST-permission'],
        }),
      },
      warnings: [],
      diagnostics: [],
    })
  );
  const reconcile = vi.fn(async (input: { teamName: string; runId: string }) => ({
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'active' as const,
    teamLaunchState: 'clean_success' as const,
    members: {
      'team-lead': evidence('team-lead', { sessionId: 'TEST-session', runtimePid: 900 }),
      builder: evidence('builder', {
        runtimeAlive: false,
        bootstrapConfirmed: false,
      }),
    },
    snapshot: null,
    warnings: [],
    diagnostics: [],
  }));
  const stop = vi.fn(async () => ({
    runId: run.runId,
    teamName: run.teamName,
    members: {},
    warnings: [],
    diagnostics: [],
  }));
  const listRuntimePermissions = vi.fn(async () => ({
    permissions: [
      { providerId: 'opencode' as const, requestId: 'TEST-permission', sessionId: 'TEST-session' },
    ],
    diagnostics: [],
  }));
  const answerRuntimePermission = vi.fn(async () => ({
    runId: run.runId,
    teamName: run.teamName,
    launchPhase: 'active' as const,
    teamLaunchState: 'clean_success' as const,
    members: { 'team-lead': evidence('team-lead') },
    warnings: [],
    diagnostics: [],
  }));
  const adapter = {
    launch,
    reconcile,
    stop,
    listRuntimePermissions,
    answerRuntimePermission,
  } as unknown as Pick<
    TeamLaunchRuntimeAdapter,
    'launch' | 'reconcile' | 'stop' | 'answerRuntimePermission' | 'listRuntimePermissions'
  >;
  const runtime = new NativeOpenCodeLaneRuntime({ adapter, reconcileIntervalMs: 2_000 });
  return {
    runtime,
    launch,
    reconcile,
    stop,
    listRuntimePermissions,
    answerRuntimePermission,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('native OpenCode lane runtime', () => {
  it('launches the lane once and maps member evidence to lane observations', async () => {
    const { runtime, launch } = setup();
    const group = await runtime.startLaneGroup(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        teamName: run.teamName,
        laneId: 'primary',
        providerId: 'opencode',
        cwd: '/TEST/cwd',
        prompt: 'TEST lead prompt',
        skipPermissions: true,
        expectedMembers: [
          expect.objectContaining({ name: 'team-lead', role: 'lead' }),
          expect.objectContaining({ name: 'builder', role: 'member' }),
        ],
      })
    );
    expect(group.observations['team-lead']).toEqual({
      laneId: 'primary',
      sessionId: 'TEST-session',
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    });
    expect(group.observations.builder).toEqual({
      laneId: 'primary',
      sessionId: null,
      hostPid: null,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      permissionBlocked: true,
      pendingPermissionRequestIds: ['TEST-permission'],
    });
  });

  it('uses the secondary lane id for a single-member start', async () => {
    const { runtime, launch } = setup();
    await runtime.startLane(
      settings('builder', 'member'),
      token('builder'),
      new AbortController().signal
    );
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: 'secondary:opencode:builder' })
    );
  });

  it('stops the lane and rejects stdin input', async () => {
    const { runtime, stop } = setup();
    const group = await runtime.startLaneGroup(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    await group.stop();
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: 'primary',
        providerId: 'opencode',
        reason: 'user_requested',
      })
    );
    await expect(group.writeInput('team-lead', 'TEST input')).rejects.toThrow('inbox relay');
  });

  it('stops the lane and rejects when adapter evidence is missing for a member', async () => {
    const { runtime, launch, stop } = setup();
    launch.mockResolvedValueOnce({
      runId: run.runId,
      teamName: run.teamName,
      launchPhase: 'active',
      teamLaunchState: 'clean_success',
      members: { 'team-lead': evidence('team-lead') },
      warnings: [],
      diagnostics: [],
    });
    await expect(
      runtime.startLaneGroup(
        [settings('team-lead', 'lead'), settings('builder', 'member')],
        [token('team-lead'), token('builder')],
        'primary',
        new AbortController().signal
      )
    ).rejects.toThrow('evidence is missing');
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'cleanup' }));
  });

  it('lists and answers lane permissions for the owning member session', async () => {
    const { runtime, answerRuntimePermission } = setup();
    const group = await runtime.startLaneGroup(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    await expect(group.listPermissions?.()).resolves.toEqual([
      { memberName: 'team-lead', requestId: 'TEST-permission' },
    ]);
    await group.answerPermission?.({
      memberName: 'team-lead',
      requestId: 'TEST-permission',
      allow: true,
      message: 'TEST allow',
    });
    expect(answerRuntimePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        laneId: 'primary',
        memberName: 'team-lead',
        requestId: 'TEST-permission',
        decision: 'allow',
        message: 'TEST allow',
      })
    );
  });

  it('maps a permission without a session to the member that owns the request', async () => {
    const { runtime, listRuntimePermissions } = setup();
    listRuntimePermissions.mockResolvedValueOnce({
      permissions: [
        { providerId: 'opencode' as const, requestId: 'TEST-permission', sessionId: null },
      ],
      diagnostics: [],
    } as never);
    const group = await runtime.startLaneGroup(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    await expect(group.listPermissions?.()).resolves.toEqual([
      { memberName: 'builder', requestId: 'TEST-permission' },
    ]);
  });

  it('reports a lost member from reconcile polling', async () => {
    vi.useFakeTimers();
    const { runtime, reconcile } = setup();
    const group = await runtime.startLaneGroup(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    const lost = vi.fn();
    const events: MemberLaneGroupEvents = {
      observed: vi.fn(),
      lost,
      failed: vi.fn(),
      released: vi.fn(),
    };
    group.subscribe(events);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile).toHaveBeenCalled();
    expect(lost).toHaveBeenCalledWith('builder');
    await group.stop();
  });
});
