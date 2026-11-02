// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeOpenCodeRuntimeControlPort } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeRuntimeControlPort';

function sources(overrides: Record<string, unknown> = {}) {
  return {
    resolveLaneId: vi.fn(async () => 'lane-1'),
    bootstrap: { commitBootstrapSession: vi.fn(async () => undefined) },
    sendInboxMessage: vi.fn(async () => ({ messageId: 'msg-1' })),
    answerPermission: vi.fn(async () => true),
    emitMemberSpawnChange: vi.fn(),
    emitTaskLogChange: vi.fn(),
    now: () => '2026-11-02T00:00:00.000Z',
    ...overrides,
  } as unknown as Parameters<typeof createNativeOpenCodeRuntimeControlPort>[0];
}

const base = {
  teamName: 'TEST-team',
  runId: 'run-1',
  memberName: 'builder',
  runtimeSessionId: 'session-1',
};

describe('native runtime control port', () => {
  it('records a bootstrap checkin against the lane the member is on', async () => {
    const deps = sources();
    const port = createNativeOpenCodeRuntimeControlPort(deps);

    const ack = await port.recordOpenCodeRuntimeBootstrapCheckin({ ...base });

    expect(ack).toMatchObject({
      ok: true,
      providerId: 'opencode',
      state: 'accepted',
      teamName: 'TEST-team',
      memberName: 'builder',
      location: { laneId: 'lane-1' },
    });
    expect(deps.bootstrap.commitBootstrapSession).toHaveBeenCalledWith({
      teamName: 'TEST-team',
      laneId: 'lane-1',
      runId: 'run-1',
      memberName: 'builder',
      runtimeSessionId: 'session-1',
      observedAt: '2026-11-02T00:00:00.000Z',
    });
    expect(deps.emitMemberSpawnChange).toHaveBeenCalledWith({
      teamName: 'TEST-team',
      runId: 'run-1',
      memberName: 'builder',
    });
  });

  it('delivers a runtime message into the recipient inbox and answers delivered', async () => {
    const deps = sources();
    const port = createNativeOpenCodeRuntimeControlPort(deps);

    const ack = await port.deliverOpenCodeRuntimeMessage({
      ...base,
      to: 'team-lead',
      text: 'done',
      idempotencyKey: 'key-1',
    });

    expect(ack).toMatchObject({
      state: 'delivered',
      idempotencyKey: 'key-1',
      location: { recipient: 'team-lead', messageId: 'msg-1' },
    });
    expect(deps.sendInboxMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'TEST-team',
        recipient: 'team-lead',
        from: 'builder',
        text: 'done',
        messageId: 'key-1',
      })
    );
  });

  it('maps the permission decision and reports when the approval is gone', async () => {
    const answered = sources();
    const port = createNativeOpenCodeRuntimeControlPort(answered);
    await port.answerOpenCodeRuntimePermission({
      ...base,
      requestId: 'req-1',
      decision: 'allow',
    });
    expect(answered.answerPermission).toHaveBeenCalledWith({
      teamName: 'TEST-team',
      runId: 'run-1',
      memberName: 'builder',
      requestId: 'req-1',
      allow: true,
    });

    const gone = sources({ answerPermission: vi.fn(async () => false) });
    const gonePort = createNativeOpenCodeRuntimeControlPort(gone);
    const ack = await gonePort.answerOpenCodeRuntimePermission({
      ...base,
      requestId: 'req-2',
      decision: 'deny',
    });
    expect(ack.diagnostics).toEqual(['approval was no longer pending']);
  });

  it('refuses a payload without the fields the endpoint needs', async () => {
    const port = createNativeOpenCodeRuntimeControlPort(sources());

    await expect(port.recordOpenCodeRuntimeHeartbeat({ teamName: 'TEST-team' })).rejects.toThrow(
      /non-empty runId/
    );
    await expect(port.deliverOpenCodeRuntimeMessage('not-an-object')).rejects.toThrow(
      /must be an object/
    );
  });

  it('records task events through the task-log change path', async () => {
    const deps = sources();
    const port = createNativeOpenCodeRuntimeControlPort(deps);

    const ack = await port.recordOpenCodeRuntimeTaskEvent({
      ...base,
      taskId: 'TASK-1',
      detail: 'started',
    });

    expect(ack).toMatchObject({ state: 'recorded', location: { taskId: 'TASK-1' } });
    expect(deps.emitTaskLogChange).toHaveBeenCalledWith({
      teamName: 'TEST-team',
      runId: 'run-1',
      taskId: 'TASK-1',
      detail: 'started',
    });
  });
});
