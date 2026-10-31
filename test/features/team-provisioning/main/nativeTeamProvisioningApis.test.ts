// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeTeamProvisioningApis } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningApis';

import type { NativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const progress = {
  runId: 'TEST-run',
  teamName: 'TEST-team',
  status: 'running',
} as unknown as TeamProvisioningProgress;

function setup() {
  const relay = vi.fn(async () => 2);
  const findByRunId = vi.fn(async () => progress);
  const memberCommands = {
    restartMember: vi.fn(),
    skipMember: vi.fn(),
    retryFailedLanes: vi.fn(),
    answerLanePermission: vi.fn(),
  };
  const toolApprovalSettings = { get: vi.fn(), update: vi.fn() };
  const lifecycle = {
    owner,
    runs: {
      find: vi.fn((teamName: string) =>
        teamName === 'TEST-team'
          ? {
              identity: { teamName, runId: 'TEST-run' },
              members: { builder: { memberName: 'builder', generation: 1 } },
            }
          : null
      ),
    },
    queries: {},
    settings: { findConfiguredMember: vi.fn(async () => null) },
    memberCommands,
    relay: { relay },
    sendLeadMessage: vi.fn(),
    approvals: { list: vi.fn(() => []), respond: vi.fn(), onEvent: vi.fn() },
    toolApprovalSettings,
  };
  const runtime = {
    createTeam: vi.fn(),
    launchTeam: vi.fn(),
    cancelProvisioning: vi.fn(async () => undefined),
    hasProvisioningRun: vi.fn(() => false),
    getRuntimeState: vi.fn(),
    stopTeam: vi.fn(async () => undefined),
    isTeamAlive: vi.fn(() => true),
    getAliveTeams: vi.fn(() => ['TEST-team']),
    getCurrentRunId: vi.fn(() => 'TEST-run'),
    findByRunId,
  };
  const apis = createNativeTeamProvisioningApis({
    runtime: {
      lifecycle,
      runtime,
      logs: { read: vi.fn() },
      recoverStartup: vi.fn(),
    } as unknown as NativeDesktopTeamRuntime,
    preflight: {
      getCliHelpOutput: vi.fn(async () => 'help'),
      prepareForProvisioning: vi.fn(),
    },
    taskActivity: { repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(async () => undefined) },
    now: () => '2026-10-31T00:00:00.000Z',
  });
  return { apis, relay, findByRunId, memberCommands, toolApprovalSettings };
}

describe('native team provisioning API composition', () => {
  it('assembles every IPC handler surface over one runtime', () => {
    const { apis } = setup();
    expect(Object.keys(apis).sort()).toEqual([
      'claudeLogs',
      'diagnostics',
      'memberLifecycle',
      'messaging',
      'preflight',
      'provisioningRun',
      'provisioningStart',
      'provisioningStatus',
      'runtime',
      'taskActivity',
      'toolApproval',
    ]);
  });

  it('routes status and relay calls to the native runtime', async () => {
    const { apis, relay, findByRunId } = setup();
    await expect(apis.provisioningStatus.getProvisioningStatus('TEST-run')).resolves.toBe(progress);
    expect(findByRunId).toHaveBeenCalledWith('TEST-run');
    await expect(apis.messaging.relayLeadInboxMessages('TEST-team')).resolves.toBe(2);
    expect(relay).toHaveBeenCalledWith('TEST-team');
    expect(apis.runtime.getAliveTeams()).toEqual(['TEST-team']);
  });

  it('delegates member lifecycle and approval settings to the native commands', async () => {
    const { apis, memberCommands, toolApprovalSettings } = setup();
    await apis.memberLifecycle.restartMember('TEST-team', 'builder');
    expect(memberCommands.restartMember).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'TEST-team',
        runId: 'TEST-run',
        memberName: 'builder',
        generation: 1,
      })
    );
    apis.toolApproval.updateToolApprovalSettings('TEST-team', { mode: 'ask' } as never);
    expect(toolApprovalSettings.update).toHaveBeenCalledWith('TEST-team', { mode: 'ask' });
  });

  it('keeps blocked OpenCode delivery rows explicit', async () => {
    const { apis } = setup();
    await expect(
      apis.messaging.relayOpenCodeMemberInboxMessages('TEST-team', 'builder')
    ).rejects.toThrow('not configured');
    await expect(
      apis.messaging.getOpenCodeRuntimeDeliveryStatus('TEST-team', 'message')
    ).rejects.toThrow('not configured');
  });
});
