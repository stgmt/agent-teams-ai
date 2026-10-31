// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  NativeClaudeApprovalStore,
  NativeClaudeToolApprovals,
  parseClaudeControlRequest,
} from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeToolApprovals';

const token = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
  memberName: 'team-lead',
  generation: 1,
  operationId: 'TEST-op',
};

function toolRequest(requestId: string): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
  });
}

function setup() {
  const store = new NativeClaudeApprovalStore();
  const write = vi.fn(async () => undefined);
  const approvals = new NativeClaudeToolApprovals({ store, write });
  return { store, write, approvals };
}

describe('native Claude tool approvals', () => {
  it('parses tool, hook and malformed control requests', () => {
    expect(parseClaudeControlRequest(toolRequest('r1'))).toEqual({
      kind: 'tool',
      requestId: 'r1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(
      parseClaudeControlRequest(
        JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook' } })
      )
    ).toEqual({ kind: 'other', requestId: 'r2' });
    expect(parseClaudeControlRequest('not json')).toBeNull();
    expect(parseClaudeControlRequest(JSON.stringify({ type: 'assistant' }))).toBeNull();
  });

  it('registers a tool request and answers it through stdin', async () => {
    const { approvals, write } = setup();
    approvals.observeLine(token, toolRequest('r1'));
    expect(approvals.list(token.runId)).toEqual([
      expect.objectContaining({ requestId: 'r1', toolName: 'Bash' }),
    ]);
    await expect(approvals.respond(token.runId, 'r1', true)).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(
      token,
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'r1',
          response: { behavior: 'allow', updatedInput: {} },
        },
      })
    );
    await expect(approvals.respond(token.runId, 'r1', true)).resolves.toBe(false);
  });

  it('auto-allows non-tool control requests to prevent a CLI deadlock', () => {
    const { approvals, write } = setup();
    approvals.observeLine(
      token,
      JSON.stringify({
        type: 'control_request',
        request_id: 'hook-1',
        request: { subtype: 'hook' },
      })
    );
    expect(write).toHaveBeenCalledWith(token, expect.stringContaining('"request_id":"hook-1"'));
  });

  it('clears pending approvals for a released run', () => {
    const { approvals } = setup();
    approvals.observeLine(token, toolRequest('r1'));
    approvals.clearRun(token.runId);
    expect(approvals.list(token.runId)).toEqual([]);
  });
});
