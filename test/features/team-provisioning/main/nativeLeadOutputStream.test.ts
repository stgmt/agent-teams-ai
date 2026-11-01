// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeLeadLiveMessageStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadLiveMessageStore';
import { NativeLeadOutputStream } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadOutputStream';

import type {
  MemberProcessToken,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';

const token: MemberProcessToken = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
  memberName: 'team-lead',
  generation: 1,
  operationId: 'TEST-op',
};

const identity: TeamRunIdentity = {
  appInstanceId: token.appInstanceId,
  dataRootFingerprint: token.dataRootFingerprint,
  connectionGeneration: token.connectionGeneration,
  teamName: token.teamName,
  runId: token.runId,
};

const lead = { token, memberName: 'team-lead', role: 'lead' as const };

function assistant(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'assistant', message: { content }, session_id: 'sess-1', ...extra });
}

function setup(options: { emitThrottleMs?: number } = {}) {
  const liveLeadMessages = new NativeLeadLiveMessageStore();
  const notifyLeadMessage = vi.fn();
  let now = 1_000;
  const output = new NativeLeadOutputStream({
    liveLeadMessages,
    notifyLeadMessage,
    nowMs: () => now,
    nowIso: () => '2026-11-01T00:00:00.000Z',
    ...(options.emitThrottleMs !== undefined ? { emitThrottleMs: options.emitThrottleMs } : {}),
  });
  return {
    output,
    notifyLeadMessage,
    messages: () => liveLeadMessages.read(identity, output.detectedSessionId(token.runId)),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('NativeLeadOutputStream', () => {
  it('projects assistant text into one live lead message and skips internal control text', () => {
    const { output, messages } = setup();

    output.observeLine(lead, assistant([{ type: 'text', text: 'Working on the migration.' }]));
    output.observeLine(
      lead,
      assistant([{ type: 'text', text: '<agent_teams_native_bootstrap_control>hidden</>'}])
    );

    const live = messages();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      from: 'team-lead',
      text: 'Working on the migration.',
      source: 'lead_process',
      leadSessionId: 'sess-1',
    });
  });

  it('coalesces synthetic chunks into the same message id', () => {
    const { output, messages } = setup();
    const chunk = (text: string) =>
      assistant([{ type: 'text', text }], { message: { model: '<synthetic>', type: 'message', content: [{ type: 'text', text }] } });

    output.observeLine(lead, chunk('Hello'));
    const [first] = messages();
    output.observeLine(lead, chunk(', world'));

    const live = messages();
    expect(live).toHaveLength(1);
    expect(live[0].messageId).toBe(first.messageId);
    expect(live[0].text).toBe('Hello, world');
  });

  it('starts a new segment after a tool call and reports the tool as active', () => {
    const { output, messages } = setup();

    output.observeLine(lead, assistant([{ type: 'text', text: 'Reading the file.' }]));
    output.observeLine(
      lead,
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/x/y.ts' } }])
    );
    output.observeLine(lead, assistant([{ type: 'text', text: 'Found it.' }]));

    const live = messages();
    expect(live.map((message) => message.text)).toEqual(['Reading the file.', 'Found it.']);
    expect(live[1].toolCalls).toEqual([{ name: 'Read', preview: 'y.ts', toolUseId: 'tool-1' }]);
    expect(live[0].messageId).not.toBe(live[1].messageId);
    expect(output.facts(token.runId)).toMatchObject({
      activity: 'active',
      activeToolCalls: ['Read'],
    });
  });

  it('drops an active tool once its result arrives and settles the turn on success', () => {
    const { output } = setup();

    output.observeLine(
      lead,
      assistant([{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }])
    );
    expect(output.facts(token.runId)?.activity).toBe('active');

    output.observeLine(
      lead,
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
      })
    );
    expect(output.facts(token.runId)?.activeToolCalls).toEqual([]);

    output.observeLine(lead, JSON.stringify({ type: 'result', subtype: 'success' }));
    expect(output.facts(token.runId)).toMatchObject({
      activity: 'idle',
      activeToolCalls: [],
      lastActivityAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('ignores non-lead members, non-JSON noise, and a failed result does not settle the turn', () => {
    const { output, messages } = setup();

    output.observeLine({ ...lead, role: 'member' }, assistant([{ type: 'text', text: 'nope' }]));
    output.observeLine(lead, 'not json at all');
    output.observeLine(lead, assistant([{ type: 'text', text: 'Working.' }]));
    output.observeLine(lead, JSON.stringify({ type: 'result', subtype: 'error_max_turns' }));

    expect(messages().map((message) => message.text)).toEqual(['Working.']);
    expect(output.facts(token.runId)?.activity).toBe('active');
  });

  it('throttles the change notification and stops reporting after clearRun', () => {
    const { output, notifyLeadMessage, advance } = setup({ emitThrottleMs: 2_000 });

    output.observeLine(lead, assistant([{ type: 'text', text: 'one' }]));
    output.observeLine(lead, assistant([{ type: 'text', text: 'two' }]));
    expect(notifyLeadMessage).toHaveBeenCalledTimes(1);

    advance(2_000);
    output.observeLine(lead, assistant([{ type: 'text', text: 'three' }]));
    expect(notifyLeadMessage).toHaveBeenCalledTimes(2);
    expect(notifyLeadMessage).toHaveBeenLastCalledWith('test-team', 'TEST-run');

    output.clearRun(token.runId);
    expect(output.facts(token.runId)).toBeNull();
    expect(output.detectedSessionId(token.runId)).toBeNull();
  });
});
