// @vitest-environment node
import { createSdkRuntimePlan, rejectUnexpectedRecovery } from './nodeMemberRuntimeFixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import {
  NativeClaudeApprovalStore,
  NativeClaudeToolApprovals,
} from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeToolApprovals';
import { NativeLeadLiveMessageStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadLiveMessageStore';
import { NativeLeadOutputStream } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadOutputStream';
import { createObservedMemberPlanner } from '../../../../src/features/team-provisioning/main/adapters/output/NativeObservedMemberPlanner';
import { NativeTeamLogStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamLogStore';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

import type { MemberProcessToken } from '../../../../src/features/team-provisioning/contracts';
import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const context = new BoundControlContext('TEST-app', 'TEST-root');

/**
 * A real child emits lead stream-json events through the SDK WebSocket.
 * This proves child -> authenticated SDK capture -> live message projection,
 * with stdout retained only for process diagnostics.
 */
const LEAD_SCRIPT = `
const lines = [
  { type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'text', text: 'Examining the repository.' }] } },
  { type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/src/index.ts' } }] } },
  { type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'text', text: 'Found the owner.' }] } },
  { type: 'result', subtype: 'success', session_id: 'TEST-session' }
];
for (const event of lines) await send(event);
await finish(0);
`;

function launchSettings(token: MemberProcessToken): ConfiguredMemberLaunch {
  return {
    team: token,
    memberName: token.memberName,
    configurationRevision: 'TEST-revision',
    providerId: 'TEST-node-process',
    model: null,
    role: 'lead',
    workingDirectory: process.cwd(),
    instructions: 'TEST lead stream observation',
    specIntegration: {
      scope: { projects: ['TEST/project'], bindings: [] },
      environment: {
        OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
        OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
      },
    },
  };
}

describe('observed member planner', () => {
  it('turns a real lead process stream into live messages, turn facts and log lines', async () => {
    const owner = context.snapshot();
    const token: MemberProcessToken = {
      ...owner,
      teamName: 'TEST-team',
      runId: 'TEST-run',
      memberName: 'team-lead',
      generation: 1,
      operationId: 'TEST-start',
    };
    const liveLeadMessages = new NativeLeadLiveMessageStore();
    const notifyLeadMessage = vi.fn();
    const leadOutput = new NativeLeadOutputStream({ liveLeadMessages, notifyLeadMessage });
    // A real team directory belongs in a temp root, not in the repository checkout.
    const teamsRoot = await mkdtemp(join(tmpdir(), 'TEST-teams-'));
    const logs = new NativeTeamLogStore({ teamsRoot });
    const approvals = new NativeClaudeToolApprovals({
      store: new NativeClaudeApprovalStore(),
      write: () => Promise.resolve(),
    });

    const runtime = new NodeMemberRuntime(
      createObservedMemberPlanner(
        {
          prepare: async (_settings, token) => createSdkRuntimePlan(LEAD_SCRIPT, token),
          recover: rejectUnexpectedRecovery,
        },
        { approvals, leadOutput, logs }
      ),
      async (expected, operation) => {
        const release = context.admit(expected);
        try {
          return await operation();
        } finally {
          release();
        }
      }
    );

    const identity = {
      appInstanceId: token.appInstanceId,
      dataRootFingerprint: token.dataRootFingerprint,
      connectionGeneration: token.connectionGeneration,
      teamName: token.teamName,
      runId: token.runId,
    };
    const member = await runtime.spawn(launchSettings(token), token, new AbortController().signal);
    const unsubscribe = member.subscribe({
      connected: () => undefined,
      connectionLost: () => undefined,
      exited: () => undefined,
      failed: () => undefined,
      releaseFailed: () => undefined,
      released: () => undefined,
    });

    await expect
      .poll(() => liveLeadMessages.read(identity, null).length, { timeout: 20_000 })
      .toBe(2);
    const live = liveLeadMessages.read(identity, null);
    expect(live.map((message) => message.text)).toEqual([
      'Examining the repository.',
      'Found the owner.',
    ]);
    expect(live[0]).toMatchObject({ from: 'team-lead', source: 'lead_process' });
    expect(live[1].toolCalls).toEqual([{ name: 'Read', preview: 'index.ts', toolUseId: 'tool-1' }]);
    expect(leadOutput.detectedSessionId(token.runId)).toBe('TEST-session');
    // The live messages above arrive from assistant events; the `result` event that closes the
    // turn is a later frame in the same serial stream, so the idle fact is awaited, not assumed.
    await expect
      .poll(() => leadOutput.facts(token.runId)?.activity, { timeout: 20_000 })
      .toBe('idle');
    expect(leadOutput.facts(token.runId)).toMatchObject({ activity: 'idle' });
    expect(notifyLeadMessage).toHaveBeenCalled();
    expect(logs.read(token.teamName).lines).toEqual(
      expect.arrayContaining([expect.stringContaining('Found the owner.')])
    );

    unsubscribe();
    await member.stop();
    await rm(teamsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
});
