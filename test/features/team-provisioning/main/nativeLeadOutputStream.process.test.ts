// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NativeClaudeApprovalStore, NativeClaudeToolApprovals } from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeToolApprovals';
import { NativeLeadLiveMessageStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadLiveMessageStore';
import { NativeLeadOutputStream } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadOutputStream';
import { createObservedMemberPlanner } from '../../../../src/features/team-provisioning/main/adapters/output/NativeObservedMemberPlanner';
import { NativeTeamLogStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamLogStore';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

import type { MemberProcessToken } from '../../../../src/features/team-provisioning/contracts';
import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const context = new BoundControlContext('TEST-app', 'TEST-root');

/**
 * A real child process prints the Claude CLI stream-json lines a lead emits.
 * This proves the observation seam itself: process stdout -> capture -> live
 * message store, not just the projection unit.
 */
const LEAD_SCRIPT = `
const lines = [
  JSON.stringify({ type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'text', text: 'Examining the repository.' }] } }),
  JSON.stringify({ type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/src/index.ts' } }] } }),
  JSON.stringify({ type: 'assistant', session_id: 'TEST-session', message: { content: [{ type: 'text', text: 'Found the owner.' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', session_id: 'TEST-session' })
];
process.stdout.write(lines.join('\\n') + '\\n', () => process.exit(0));
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
  } as unknown as ConfiguredMemberLaunch;
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
          prepare: async () => ({
            executable: process.execPath,
            args: ['-e', LEAD_SCRIPT],
            cwd: process.cwd(),
            env: process.env,
          }),
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
    const member = await runtime.spawn(
      launchSettings(token),
      token,
      new AbortController().signal
    );
    const unsubscribe = member.subscribe({
      connected: () => undefined,
      connectionLost: () => undefined,
      exited: () => undefined,
      failed: () => undefined,
      releaseFailed: () => undefined,
      released: () => undefined,
    });

    await expect.poll(() => liveLeadMessages.read(identity, null).length).toBe(2);
    const live = liveLeadMessages.read(identity, null);
    expect(live.map((message) => message.text)).toEqual([
      'Examining the repository.',
      'Found the owner.',
    ]);
    expect(live[0]).toMatchObject({ from: 'team-lead', source: 'lead_process' });
    expect(live[1].toolCalls).toEqual([
      { name: 'Read', preview: 'index.ts', toolUseId: 'tool-1' },
    ]);
    expect(leadOutput.detectedSessionId(token.runId)).toBe('TEST-session');
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
