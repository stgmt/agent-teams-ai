import { describe, expect, it, vi } from 'vitest';

import {
  closeRelayUserRequests,
  completeLeadTurn,
  finishLeadUserReplyTurn,
  forgetUserRequest,
  readLiveLeadTextBuffer,
  recordLeadTurnText,
  registerDirectUserRequest,
  registerRelayUserRequests,
  takeRequestIdsForExplicitReply,
} from '../TeamProvisioningLeadUserReplyTracker';

const TURN_INPUT = {
  leadName: 'lead',
  runId: 'run-1',
  nowIso: '2026-10-25T10:00:00.000Z',
  nowMs: 1,
};

function createRun(leadActivityState: 'active' | 'idle' = 'idle'): {
  teamName: string;
  runId: string;
  leadActivityState: 'active' | 'idle';
} {
  return { teamName: 'alpha', runId: 'run-1', leadActivityState };
}

describe('TeamProvisioningLeadUserReplyTracker', () => {
  it('links an explicit SendMessage to user to every open request', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    registerRelayUserRequests(run, ['req-2']);

    expect(takeRequestIdsForExplicitReply(run)).toEqual(['req-1', 'req-2']);
    expect(completeLeadTurn(run, TURN_INPUT).fallbackReply).toBeNull();
  });

  it('links a later reply (the result after an ack) to the requests answered last', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    expect(takeRequestIdsForExplicitReply(run)).toEqual(['req-1']);
    completeLeadTurn(run, TURN_INPUT);
    expect(takeRequestIdsForExplicitReply(run)).toEqual(['req-1']);
  });

  it('leaves a request queued behind the running turn open for its own turn', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    run.leadActivityState = 'active';
    registerDirectUserRequest(run, 'req-2');

    expect(takeRequestIdsForExplicitReply(run)).toEqual(['req-1']);
    completeLeadTurn(run, TURN_INPUT);
    recordLeadTurnText(run, 'Here is the transcript.');
    expect(completeLeadTurn(run, TURN_INPUT).fallbackReply).toMatchObject({
      replyToMessageIds: ['req-2'],
    });
  });

  it('promotes the last lead text of the answering turn to a focus-only fallback reply', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    recordLeadTurnText(run, 'Checking the board');
    recordLeadTurnText(run, 'Here is the report for the manager.');

    const result = completeLeadTurn(run, TURN_INPUT);

    expect(result.fallbackReply).toMatchObject({
      from: 'lead',
      to: 'user',
      text: 'Here is the report for the manager.',
      replyToMessageIds: ['req-1'],
      replyChannel: 'fallback',
      focusOnly: true,
      read: true,
    });
    expect(completeLeadTurn(run, TURN_INPUT).fallbackReply).toBeNull();
  });

  it('does not answer a request written while the lead was busy with the running turn', () => {
    const run = createRun('active');
    registerDirectUserRequest(run, 'req-1');
    recordLeadTurnText(run, 'DEPLOY got its answer.');

    expect(completeLeadTurn(run, TURN_INPUT).fallbackReply).toBeNull();

    recordLeadTurnText(run, 'Transcript is attached.');
    expect(completeLeadTurn(run, TURN_INPUT).fallbackReply).toMatchObject({
      text: 'Transcript is attached.',
      replyToMessageIds: ['req-1'],
    });
  });

  it('ignores text recorded in an earlier turn', () => {
    const run = createRun('active');
    registerDirectUserRequest(run, 'req-1');
    recordLeadTurnText(run, 'Old turn text');
    completeLeadTurn(run, TURN_INPUT);

    const result = completeLeadTurn(run, TURN_INPUT);
    expect(result.fallbackReply).toBeNull();
    expect(result.unansweredRequestIds).toEqual(['req-1']);
  });

  it('reports a request closed without any text as unanswered', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    recordLeadTurnText(run, '<info_for_agent>internal only</info_for_agent>');

    const result = completeLeadTurn(run, TURN_INPUT);
    expect(result.fallbackReply).toBeNull();
    expect(result.unansweredRequestIds).toEqual(['req-1']);
  });

  it('leaves relay requests to the relay flow', () => {
    const run = createRun();
    registerRelayUserRequests(run, ['req-1']);
    recordLeadTurnText(run, 'Relay answer');

    expect(completeLeadTurn(run, TURN_INPUT)).toEqual({
      fallbackReply: null,
      unansweredRequestIds: [],
    });
    closeRelayUserRequests(run, ['req-1']);
    expect(takeRequestIdsForExplicitReply(run)).toEqual([]);
  });

  it('forgets a direct request whose stdin write failed', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    forgetUserRequest(run, 'req-1');
    expect(takeRequestIdsForExplicitReply(run)).toEqual([]);
  });

  it('reads the coalesced stream buffer text', () => {
    expect(readLiveLeadTextBuffer({ text: 'full text' })).toBe('full text');
    expect(readLiveLeadTextBuffer({ text: '  ' })).toBeNull();
    expect(readLiveLeadTextBuffer(null)).toBeNull();
  });

  it('persists and announces the fallback reply at turn end', () => {
    const run = createRun();
    registerDirectUserRequest(run, 'req-1');
    recordLeadTurnText(run, 'Done: the transcript is in the task comment.');
    const ports = {
      leadName: 'lead',
      nowIso: () => TURN_INPUT.nowIso,
      nowMs: () => 42,
      persistSentMessage: vi.fn(),
      pushLiveLeadProcessMessage: vi.fn(),
      emitInboxChange: vi.fn(),
      logger: { warn: vi.fn() },
    };

    finishLeadUserReplyTurn(run, ports);

    const reply = ports.persistSentMessage.mock.calls[0]?.[1];
    expect(reply).toMatchObject({ messageId: 'lead-reply-fallback-run-1-42', focusOnly: true });
    expect(ports.pushLiveLeadProcessMessage).toHaveBeenCalledWith('alpha', reply);
    expect(ports.emitInboxChange).toHaveBeenCalledWith('alpha', 'sentMessages.json');
    expect(ports.logger.warn).toHaveBeenCalledTimes(1);
  });
});
