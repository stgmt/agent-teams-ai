// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeRuntimeToolApproval } from '../../../../src/features/team-provisioning/main/composition/createNativeRuntimeToolApproval';

import type { RuntimeToolApprovalEntry } from '@main/services/team/approvals/RuntimeToolApprovalCoordinator';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { ToolApprovalSettings } from '@shared/types/team';

const settings = {
  mode: 'manual',
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'deny',
  timeoutSeconds: 0,
} as unknown as ToolApprovalSettings;

const openCodeEntry = {
  providerId: 'opencode',
  providerRequestId: 'req-1',
  laneId: 'lane-1',
  memberName: 'Builder',
  approval: {
    teamName: 'TEST-team',
    runId: 'run-1',
    requestId: 'req-1',
    toolName: 'bash',
  },
} as unknown as RuntimeToolApprovalEntry;

const state = {
  teamName: 'TEST-team',
  runId: 'run-1',
  laneId: 'lane-1',
  cwd: 'C:/TEST',
  members: {},
  expectedMembers: [],
} as unknown as Record<string, never>;

describe('native runtime tool approval', () => {
  it('records a lane approval and answers it through the OpenCode bridge', async () => {
    const answerRuntimePermission = vi.fn(async () => ({}) as never);
    const emitApprovalEvent = vi.fn();
    const approval = createNativeRuntimeToolApproval({
      getSettings: () => settings,
      openCodeAdapter: () =>
        ({ answerRuntimePermission }) as unknown as TeamLaunchRuntimeAdapter,
      emitApprovalEvent,
      approvals: { collect: () => [openCodeEntry] },
    });

    approval.syncOpenCodeRuntimeToolApprovals({
      ...(state as unknown as object),
      teamName: 'TEST-team',
      runId: 'run-1',
      laneId: 'lane-1',
    } as never);

    expect(emitApprovalEvent).toHaveBeenCalled();
    await expect(
      approval.respond({
        teamName: 'TEST-team',
        runId: 'run-1',
        requestId: 'req-1',
        allow: true,
      })
    ).resolves.toBe(true);
    expect(answerRuntimePermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', decision: 'allow' })
    );
  });

  it('refuses to answer when the runtime bridge cannot take the answer', async () => {
    const approval = createNativeRuntimeToolApproval({
      getSettings: () => settings,
      openCodeAdapter: () => ({}) as unknown as TeamLaunchRuntimeAdapter,
      emitApprovalEvent: () => undefined,
      approvals: { collect: () => [openCodeEntry] },
    });

    approval.syncOpenCodeRuntimeToolApprovals({
      ...(state as unknown as object),
      teamName: 'TEST-team',
      runId: 'run-1',
      laneId: 'lane-1',
    } as never);

    await expect(
      approval.respond({
        teamName: 'TEST-team',
        runId: 'run-1',
        requestId: 'req-1',
        allow: true,
      })
    ).rejects.toThrow(/cannot answer tool approvals/);
  });

  it('treats an approval that is no longer pending as answered nowhere', async () => {
    const approval = createNativeRuntimeToolApproval({
      getSettings: () => settings,
      openCodeAdapter: () => ({}) as unknown as TeamLaunchRuntimeAdapter,
      emitApprovalEvent: () => undefined,
    });

    await expect(
      approval.respond({
        teamName: 'TEST-team',
        runId: 'run-1',
        requestId: 'missing',
        allow: true,
      })
    ).resolves.toBe(false);
  });
});
