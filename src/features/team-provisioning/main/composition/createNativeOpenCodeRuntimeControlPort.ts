import type { NativeOpenCodeBootstrapEvidence } from '../adapters/output/NativeOpenCodeBootstrapEvidence';
import type { OpenCodeRuntimeControlAck } from '@main/services/team/runtime-control';
import type { OpenCodeRuntimeControlPort } from '@main/services/team/runtime-control/application/OpenCodeRuntimeControlProvider';

/**
 * What the runtime-control endpoints need from the shell.
 *
 * These endpoints are the running OpenCode host calling back in: "my session is up",
 * "I am still alive", "the member finished a task", "the user answered an approval",
 * and "a member wants to say something to the team".
 */
export interface NativeOpenCodeRuntimeControlSources {
  /** The lane a member is on; the runtime names members, the ledger is keyed by lane. */
  resolveLaneId(input: { teamName: string; runId: string; memberName?: string }): Promise<string>;
  bootstrap: Pick<NativeOpenCodeBootstrapEvidence, 'commitBootstrapSession'>;
  /** Writes a runtime member's message into the recipient's inbox. */
  sendInboxMessage(input: {
    teamName: string;
    recipient: string;
    from: string;
    text: string;
    messageId?: string;
    observedAt: string;
  }): Promise<{ messageId: string }>;
  /** Answers an approval the member is waiting on. */
  answerPermission(input: {
    teamName: string;
    runId: string;
    memberName: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }): Promise<boolean>;
  emitMemberSpawnChange(input: { teamName: string; runId: string; memberName: string }): void;
  emitTaskLogChange(input: {
    teamName: string;
    runId: string;
    taskId: string;
    detail: string;
  }): void;
  now?(): string;
}

const REQUIRED = ['teamName', 'runId', 'memberName', 'runtimeSessionId'] as const;

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object')
    throw new Error('OpenCode runtime payload must be an object');
  return raw as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OpenCode runtime payload requires a non-empty ${key}`);
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ack(
  state: OpenCodeRuntimeControlAck['state'],
  fields: {
    teamName: string;
    runId: string;
    memberName?: string;
    runtimeSessionId?: string;
    observedAt: string;
    diagnostics?: string[];
    location?: Record<string, string | number | boolean | null>;
    idempotencyKey?: string;
  }
): OpenCodeRuntimeControlAck {
  return {
    ok: true,
    providerId: 'opencode',
    state,
    diagnostics: fields.diagnostics ?? [],
    ...fields,
  };
}

/**
 * The five endpoints the running host calls.
 *
 * Liveness is not stored here: the runtime's own lane observations already reach the
 * lifecycle, which owns "is this member alive". Recording it twice would let the two
 * answers disagree, and the interface would show a member as both up and down.
 */
export function createNativeOpenCodeRuntimeControlPort(
  sources: NativeOpenCodeRuntimeControlSources
): OpenCodeRuntimeControlPort {
  const nowIso = sources.now ?? (() => new Date().toISOString());

  return {
    async recordOpenCodeRuntimeBootstrapCheckin(raw) {
      const payload = record(raw);
      const teamName = requiredString(payload, 'teamName');
      const runId = requiredString(payload, 'runId');
      const memberName = requiredString(payload, 'memberName');
      const runtimeSessionId = requiredString(payload, 'runtimeSessionId');
      const observedAt = optionalString(payload, 'observedAt') ?? nowIso();
      const laneId = await sources.resolveLaneId({ teamName, runId, memberName });
      await sources.bootstrap.commitBootstrapSession({
        teamName,
        laneId,
        runId,
        memberName,
        runtimeSessionId,
        observedAt,
      });
      sources.emitMemberSpawnChange({ teamName, runId, memberName });
      return ack('accepted', {
        teamName,
        runId,
        memberName,
        runtimeSessionId,
        observedAt,
        location: { laneId },
      });
    },

    async recordOpenCodeRuntimeHeartbeat(raw) {
      const payload = record(raw);
      const teamName = requiredString(payload, 'teamName');
      const runId = requiredString(payload, 'runId');
      const memberName = requiredString(payload, 'memberName');
      const runtimeSessionId = requiredString(payload, 'runtimeSessionId');
      const observedAt = optionalString(payload, 'observedAt') ?? nowIso();
      // The lane is resolved so a heartbeat for an unknown lane is refused rather than
      // counted as proof that some other lane is alive.
      const laneId = await sources.resolveLaneId({ teamName, runId, memberName });
      return ack('recorded', {
        teamName,
        runId,
        memberName,
        runtimeSessionId,
        observedAt,
        location: { laneId },
      });
    },

    async recordOpenCodeRuntimeTaskEvent(raw) {
      const payload = record(raw);
      const teamName = requiredString(payload, 'teamName');
      const runId = requiredString(payload, 'runId');
      const memberName = requiredString(payload, 'memberName');
      const taskId = requiredString(payload, 'taskId');
      const detail =
        optionalString(payload, 'detail') ?? optionalString(payload, 'event') ?? 'task event';
      const observedAt = optionalString(payload, 'observedAt') ?? nowIso();
      sources.emitTaskLogChange({ teamName, runId, taskId, detail });
      return ack('recorded', { teamName, runId, memberName, observedAt, location: { taskId } });
    },

    async answerOpenCodeRuntimePermission(raw) {
      const payload = record(raw);
      const teamName = requiredString(payload, 'teamName');
      const runId = requiredString(payload, 'runId');
      const memberName = requiredString(payload, 'memberName');
      const requestId = requiredString(payload, 'requestId');
      const decision = requiredString(payload, 'decision');
      const message = optionalString(payload, 'message');
      const answered = await sources.answerPermission({
        teamName,
        runId,
        memberName,
        requestId,
        allow: decision === 'allow',
        ...(message ? { message } : {}),
      });
      return ack('accepted', {
        teamName,
        runId,
        memberName,
        observedAt: nowIso(),
        location: { requestId, answered },
        diagnostics: answered ? [] : ['approval was no longer pending'],
      });
    },

    async deliverOpenCodeRuntimeMessage(raw) {
      const payload = record(raw);
      for (const key of REQUIRED) {
        if (key !== 'runtimeSessionId') requiredString(payload, key);
      }
      const teamName = requiredString(payload, 'teamName');
      const runId = requiredString(payload, 'runId');
      const memberName = requiredString(payload, 'memberName');
      const text = requiredString(payload, 'text');
      const recipient = optionalString(payload, 'to') ?? 'team-lead';
      const observedAt = optionalString(payload, 'observedAt') ?? nowIso();
      const idempotencyKey = optionalString(payload, 'idempotencyKey');
      const sent = await sources.sendInboxMessage({
        teamName,
        recipient,
        from: memberName,
        text,
        ...(idempotencyKey ? { messageId: idempotencyKey } : {}),
        observedAt,
      });
      return ack('delivered', {
        teamName,
        runId,
        memberName,
        observedAt,
        location: { recipient, messageId: sent.messageId },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    },
  };
}
