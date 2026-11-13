// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeRuntimeToolApproval } from '../../../../src/features/team-provisioning/main/composition/createNativeRuntimeToolApproval';
import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import {
  NativeClaudeApprovalStore,
  NativeClaudeToolApprovals,
} from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeToolApprovals';

import type { RuntimeToolApprovalEntry } from '@main/services/team/approvals/RuntimeToolApprovalCoordinator';
import type { ToolApprovalSettings } from '@shared/types';

const settings: ToolApprovalSettings = {
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'deny',
  timeoutSeconds: 0,
};

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

function claudeFixture() {
  const owner = {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: 'TEST-root',
    connectionGeneration: 1,
  };
  const run = { ...owner, teamName: 'TEST-team', runId: 'run-1' };
  const token = { ...run, memberName: 'Lead', generation: 1, operationId: 'start-1' };
  const runs = new MemberLifecycleRegistry(owner);
  runs.adoptTeam(run, [
    {
      memberName: token.memberName,
      role: 'lead',
      generation: token.generation,
      operationId: token.operationId,
      process: { pid: 123, birthId: 'TEST-birth' },
      lane: null,
    },
  ]);
  const approvals = new NativeClaudeToolApprovals({
    store: new NativeClaudeApprovalStore(),
    write: vi.fn(async () => undefined),
  });
  return {
    token,
    claude: { approvals, runs },
    request(requestId: string) {
      approvals.observeLine(
        token,
        JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'git status' },
          },
        })
      );
    },
  };
}

describe('native runtime tool approval', () => {
  it('records a lane approval and answers it through the OpenCode bridge', async () => {
    const answerRuntimePermission = vi.fn(async (_input: unknown) => ({}) as never);
    const emitApprovalEvent = vi.fn();
    const approval = createNativeRuntimeToolApproval({
      getSettings: () => settings,
      claude: claudeFixture().claude,
      answerOpenCodePermission: async (input) => {
        await answerRuntimePermission(input);
      },
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
      claude: claudeFixture().claude,
      answerOpenCodePermission: async () => {
        throw new Error('OpenCode runtime bridge cannot answer tool approvals');
      },
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
      claude: claudeFixture().claude,
      answerOpenCodePermission: async () => {
        throw new Error('OpenCode runtime bridge cannot answer tool approvals');
      },
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

  it('forwards a Claude request and preserves the denied outcome', async () => {
    const fixture = claudeFixture();
    const emitApprovalEvent = vi.fn();
    createNativeRuntimeToolApproval({
      claude: fixture.claude,
      getSettings: () => settings,
      answerOpenCodePermission: vi.fn(),
      emitApprovalEvent,
    });
    fixture.request('claude-request');
    expect(emitApprovalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: fixture.token.teamName,
        runId: fixture.token.runId,
        requestId: 'claude-request',
        source: 'Lead',
        toolInput: { command: 'git status' },
      })
    );
    await fixture.claude.approvals.respond(fixture.token.runId, 'claude-request', false);
    expect(fixture.claude.approvals.list(fixture.token.runId)).toEqual([]);
    expect(emitApprovalEvent).toHaveBeenLastCalledWith({
      autoResolved: true,
      teamName: fixture.token.teamName,
      runId: fixture.token.runId,
      requestId: 'claude-request',
      reason: 'runtime_resolved',
      allowed: false,
    });
  });

  it('publishes an already pending request when the event consumer reconnects', () => {
    const fixture = claudeFixture();
    fixture.request('restored-request');
    const emitApprovalEvent = vi.fn();
    createNativeRuntimeToolApproval({
      claude: fixture.claude,
      getSettings: () => settings,
      answerOpenCodePermission: vi.fn(),
      emitApprovalEvent,
    });
    expect(emitApprovalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: fixture.token.teamName,
        runId: fixture.token.runId,
        requestId: 'restored-request',
        toolName: 'Bash',
      })
    );
  });

  it('dismisses the pending UI request when its run is cleared', () => {
    const fixture = claudeFixture();
    const emitApprovalEvent = vi.fn();
    createNativeRuntimeToolApproval({
      claude: fixture.claude,
      getSettings: () => settings,
      answerOpenCodePermission: vi.fn(),
      emitApprovalEvent,
    });
    fixture.request('stopped-request');
    fixture.claude.approvals.clearRun(fixture.token.runId);
    expect(emitApprovalEvent).toHaveBeenLastCalledWith({
      dismissed: true,
      teamName: fixture.token.teamName,
      runId: fixture.token.runId,
    });
  });
});
