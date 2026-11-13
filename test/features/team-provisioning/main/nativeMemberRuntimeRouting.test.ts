// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeMemberRuntimeRouting } from '../../../../src/features/team-provisioning/main/composition/createNativeMemberRuntimeRouting';

import type { ConfiguredMemberIdentity } from '../../../../src/features/team-provisioning/contracts';
import type {
  ConfiguredMemberLaunch,
  MemberRuntimePort,
  OwnedMemberProcess,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type { TeamRuntimeMemberLaunchEvidence } from '../../../../src/main/services/team/runtime';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};
const roster: ConfiguredMemberIdentity[] = [
  { memberName: 'team-lead', role: 'lead' },
  { memberName: 'builder', role: 'member' },
];

const evidence = (memberName: string): TeamRuntimeMemberLaunchEvidence => ({
  memberName,
  providerId: 'opencode',
  launchState: 'confirmed_alive',
  agentToolAccepted: true,
  runtimeAlive: true,
  bootstrapConfirmed: true,
  hardFailure: false,
  diagnostics: [],
});

function setup(providers: Record<string, string>, withAdapter = true) {
  const spawn = vi.fn(
    async (settings: ConfiguredMemberLaunch): Promise<OwnedMemberProcess> => ({
      identity: { pid: 1, birthId: settings.memberName },
      subscribe: () => () => undefined,
      writeInput: async () => undefined,
      stop: async () => undefined,
    })
  );
  const processRuntime: MemberRuntimePort = { spawn };
  const launch = vi.fn(async (input: { runId: string; teamName: string; laneId?: string }) => ({
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'active' as const,
    teamLaunchState: 'clean_success' as const,
    members: Object.fromEntries(['team-lead', 'builder'].map((name) => [name, evidence(name)])),
    warnings: [],
    diagnostics: [],
  }));
  const adapter = { launch, reconcile: vi.fn(), stop: vi.fn() };
  const settings = {
    findConfiguredMember: async (team: typeof run, memberName: string) =>
      ({
        team,
        memberName,
        configurationRevision: 'TEST-revision',
        providerId: providers[memberName] ?? 'anthropic',
        model: null,
        workingDirectory: '/TEST/cwd',
        instructions: 'TEST',
        specIntegration: {
          scope: { projects: ['TEST/project'], bindings: [] },
          environment: {
            OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
            OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
          },
        },
      }) satisfies ConfiguredMemberLaunch,
  };
  const routing = createNativeMemberRuntimeRouting({
    processRuntime,
    settings,
    ...(withAdapter ? { openCodeAdapter: adapter as never } : {}),
  });
  return { routing, spawn, launch };
}

describe('native member runtime routing', () => {
  it('routes a pure OpenCode roster to one primary lane', async () => {
    const { routing } = setup({ 'team-lead': 'opencode', builder: 'opencode' });
    expect(routing.runtime.kind?.('opencode')).toBe('lane');
    expect(routing.runtime.kind?.('anthropic')).toBe('process');
    expect(await routing.laneGroups(run, roster)).toEqual([
      { laneId: 'primary', memberNames: ['team-lead', 'builder'] },
    ]);
  });

  it('gives each OpenCode member a secondary lane in a mixed roster', async () => {
    const { routing } = setup({ 'team-lead': 'anthropic', builder: 'opencode' });
    expect(await routing.laneGroups(run, roster)).toEqual([
      { laneId: 'secondary:opencode:builder', memberNames: ['builder'] },
    ]);
  });

  it('keeps process providers process-only when no member is OpenCode', async () => {
    const { routing, spawn } = setup({ 'team-lead': 'anthropic', builder: 'codex' });
    expect(await routing.laneGroups(run, roster)).toEqual([]);
    const settings = {
      team: run,
      memberName: 'builder',
      configurationRevision: 'TEST-revision',
      providerId: 'codex',
      model: null,
      workingDirectory: '/TEST/cwd',
      instructions: 'TEST',
      specIntegration: {
        scope: { projects: ['TEST/project'], bindings: [] },
        environment: {
          OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
          OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
        },
      },
    } satisfies ConfiguredMemberLaunch;
    await routing.runtime.spawn(
      settings,
      { ...run, memberName: 'builder', generation: 1, operationId: 'op' },
      new AbortController().signal
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('stays process-only for OpenCode when no adapter is available', async () => {
    const { routing } = setup({ 'team-lead': 'opencode', builder: 'opencode' }, false);
    expect(routing.runtime.kind?.('opencode')).toBe('process');
    expect(await routing.laneGroups(run, roster)).toEqual([]);
    expect(routing.runtime.startLaneGroup).toBeUndefined();
  });

  it('delegates a lane group launch to the OpenCode adapter', async () => {
    const { routing, launch } = setup({ 'team-lead': 'opencode', builder: 'opencode' });
    const settings = (memberName: string, role: 'lead' | 'member') => ({
      team: run,
      memberName,
      configurationRevision: 'TEST-revision',
      providerId: 'opencode',
      model: null,
      role,
      workingDirectory: '/TEST/cwd',
      instructions: 'TEST',
      specIntegration: {
        scope: { projects: ['TEST/project'], bindings: [] },
        environment: {
          OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
          OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
        },
      },
    });
    const token = (memberName: string) => ({
      ...run,
      memberName,
      generation: 1,
      operationId: `op-${memberName}`,
    });
    await routing.runtime.startLaneGroup?.(
      [settings('team-lead', 'lead'), settings('builder', 'member')],
      [token('team-lead'), token('builder')],
      'primary',
      new AbortController().signal
    );
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ laneId: 'primary' }));
  });
});
