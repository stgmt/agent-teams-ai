import { isSyntheticLeadTextChunk } from '@main/services/team/provisioning/leadRelayCaptureStreamHooks';
import { boundLiveLeadProcessText } from '@main/services/team/provisioning/TeamProvisioningProgressBuffers';
import {
  extractStreamContentBlocks,
  getStableLeadThoughtMessageId,
} from '@main/services/team/provisioning/TeamProvisioningStreamEvents';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { isTeamInternalControlMessageText } from '@shared/utils/teamInternalControlMessages';
import { extractToolPreview, formatToolSummaryFromCalls } from '@shared/utils/toolSummary';

import type { MemberProcessToken, TeamRunIdentity } from '../../../contracts';
import type { NativeLeadLiveMessageStore } from './NativeLeadLiveMessageStore';
import type { InboxMessage, ToolCallMeta } from '@shared/types';

/** Facts a native lead turn must expose to restart assessment and lead-session routing. */
export interface NativeLeadOutputFacts {
  detectedSessionId: string | null;
  activity: 'idle' | 'active';
  activeToolCalls: readonly string[];
  lastActivityAt: string | null;
}

export interface NativeLeadOutputSubject {
  token: Readonly<MemberProcessToken>;
  memberName: string;
  role: 'lead' | 'member' | undefined;
}

interface LeadRunOutputState {
  identity: Readonly<TeamRunIdentity>;
  memberName: string;
  detectedSessionId: string | null;
  seq: number;
  buffer: {
    messageId: string;
    text: string;
    timestamp: string;
    toolCalls?: ToolCallMeta[];
    toolSummary?: string;
  } | null;
  pendingToolCalls: ToolCallMeta[];
  activeToolCalls: Map<string, string>;
  activity: 'idle' | 'active';
  lastActivityAt: string | null;
  lastEmitMs: number;
}

interface NativeLeadOutputStreamDependencies {
  liveLeadMessages: Pick<NativeLeadLiveMessageStore, 'push'>;
  /** Renderer/HTTP notification; throttled exactly like the legacy relay. */
  notifyLeadMessage?(teamName: string, runId: string): void;
  emitThrottleMs?: number;
  nowMs?(): number;
  nowIso?(): string;
}

const DEFAULT_EMIT_THROTTLE_MS = 2_000;

/** Tools whose tool_use never becomes lead-facing live text. */
const NON_DISPLAY_TOOLS: Record<string, true> = { SendMessage: true };

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readToolUseId(block: Record<string, unknown>): string | null {
  return typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
}

/**
 * Native capture of the app-owned lead process output.
 *
 * The legacy path parsed the same stream-json lines inside the provisioning run
 * model; the run model is the legacy owner, so the lines are projected here into
 * the lifecycle-owned live message store and into the turn facts restart
 * assessment needs. It owns no process and no run: `NodeMemberRuntime` calls
 * `observeLine` for every stdout line of an owned lead.
 */
export class NativeLeadOutputStream {
  private readonly byRun = new Map<string, LeadRunOutputState>();
  private readonly emitThrottleMs: number;

  constructor(private readonly deps: NativeLeadOutputStreamDependencies) {
    this.emitThrottleMs = deps.emitThrottleMs ?? DEFAULT_EMIT_THROTTLE_MS;
    if (!Number.isFinite(this.emitThrottleMs) || this.emitThrottleMs < 0)
      throw new Error('Lead output emit throttle must be a non-negative number');
  }

  observeLine(subject: NativeLeadOutputSubject, rawLine: string): void {
    if (subject.role !== 'lead') return;
    const line = rawLine.replace(/\r$/, '');
    if (!line) return;
    const message = parseLine(line);
    if (!message) return;

    const state = this.stateFor(subject);
    this.recordSessionId(state, message);

    if (message.type === 'assistant') {
      this.observeAssistant(state, message);
      return;
    }
    if (message.type === 'user') {
      // A new user turn (including a tool_result batch) closes the streamed text.
      state.buffer = null;
      for (const block of extractStreamContentBlocks(message)) {
        if (block?.type !== 'tool_result') continue;
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        if (toolUseId) state.activeToolCalls.delete(toolUseId);
      }
      return;
    }
    if (message.type === 'result') {
      // Every result closes the turn, whatever its subtype: a failure
      // (`error`, `error_during_execution`, `error_max_turns`) ends it exactly as
      // a success does, and the process stays alive. Keeping the lead `active`
      // after a failed turn would leave it that way for the rest of the run, and
      // the restart assessment reads activity - a restart would never be
      // admitted again.
      state.activeToolCalls.clear();
      state.activity = 'idle';
      state.buffer = null;
      state.pendingToolCalls = [];
    }
  }

  facts(runId: string): NativeLeadOutputFacts | null {
    const state = this.byRun.get(runId);
    if (!state) return null;
    return {
      detectedSessionId: state.detectedSessionId,
      activity: state.activity,
      activeToolCalls: [...state.activeToolCalls.values()],
      lastActivityAt: state.lastActivityAt,
    };
  }

  detectedSessionId(runId: string): string | null {
    return this.byRun.get(runId)?.detectedSessionId ?? null;
  }

  clearRun(runId: string): void {
    this.byRun.delete(runId);
  }

  private stateFor(subject: NativeLeadOutputSubject): LeadRunOutputState {
    const existing = this.byRun.get(subject.token.runId);
    if (existing) return existing;
    const state: LeadRunOutputState = {
      identity: Object.freeze({
        appInstanceId: subject.token.appInstanceId,
        dataRootFingerprint: subject.token.dataRootFingerprint,
        connectionGeneration: subject.token.connectionGeneration,
        teamName: subject.token.teamName,
        runId: subject.token.runId,
      }),
      memberName: subject.memberName,
      detectedSessionId: null,
      seq: 0,
      buffer: null,
      pendingToolCalls: [],
      activeToolCalls: new Map(),
      activity: 'idle',
      lastActivityAt: null,
      // Never emitted: the first live message must always notify.
      lastEmitMs: Number.NEGATIVE_INFINITY,
    };
    this.byRun.set(subject.token.runId, state);
    return state;
  }

  private recordSessionId(state: LeadRunOutputState, message: Record<string, unknown>): void {
    if (state.detectedSessionId) return;
    const raw = typeof message.session_id === 'string' ? message.session_id.trim() : '';
    if (raw) state.detectedSessionId = raw;
  }

  private observeAssistant(state: LeadRunOutputState, message: Record<string, unknown>): void {
    const content = extractStreamContentBlocks(message);
    const textParts = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string);

    if (textParts.length > 0) {
      const text = textParts.join('\n');
      const synthetic = isSyntheticLeadTextChunk(message);
      const displayText = synthetic ? text : stripAgentBlocks(text).trim();
      if (
        (displayText.length > 0 || (synthetic && state.buffer)) &&
        !isTeamInternalControlMessageText(displayText)
      ) {
        this.pushLiveText(state, displayText, message, synthetic);
      }
    }

    const activityText = stripAgentBlocks(textParts.join('\n')).trim();
    const observedToolUse = content.some(
      (block) =>
        block.type === 'tool_use' &&
        typeof block.name === 'string' &&
        typeof block.id === 'string'
    );
    if ((activityText.length > 0 && !isTeamInternalControlMessageText(activityText)) || observedToolUse)
      this.markActive(state);

    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const toolUseId = readToolUseId(block);
      if (toolUseId) state.activeToolCalls.set(toolUseId, block.name);
      if (NON_DISPLAY_TOOLS[block.name]) continue;
      const input =
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      state.pendingToolCalls.push({
        name: block.name,
        preview: extractToolPreview(block.name, input),
        ...(toolUseId ? { toolUseId } : {}),
      });
      state.buffer = null;
    }
  }

  private markActive(state: LeadRunOutputState): void {
    state.activity = 'active';
    state.lastActivityAt = this.nowIso();
  }

  /**
   * Coalescing rule of the legacy relay: synthetic chunks extend one message,
   * real assistant blocks start a new one, and each tool_use closes the segment.
   */
  private pushLiveText(
    state: LeadRunOutputState,
    text: string,
    message: Record<string, unknown>,
    coalesce: boolean
  ): void {
    const timestamp = this.readTimestamp(message);
    let messageId: string;
    let body: string;
    let messageTimestamp: string;
    let toolCalls: ToolCallMeta[] | undefined;
    let toolSummary: string | undefined;

    if (coalesce) {
      if (!state.buffer) {
        state.seq += 1;
        toolCalls =
          state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined;
        toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
        state.buffer = {
          messageId: `lead-turn-${state.identity.runId}-${state.seq}`,
          text: boundLiveLeadProcessText(text),
          timestamp,
          ...(toolCalls ? { toolCalls } : {}),
          ...(toolSummary ? { toolSummary } : {}),
        };
        state.pendingToolCalls = [];
      } else {
        state.buffer.text = boundLiveLeadProcessText(state.buffer.text + text);
      }
      messageId = state.buffer.messageId;
      body = stripAgentBlocks(state.buffer.text).trim();
      messageTimestamp = state.buffer.timestamp;
      toolCalls = state.buffer.toolCalls;
      toolSummary = state.buffer.toolSummary;
    } else {
      state.buffer = null;
      state.seq += 1;
      messageId =
        getStableLeadThoughtMessageId(message) || `lead-turn-${state.identity.runId}-${state.seq}`;
      body = text;
      messageTimestamp = timestamp;
      toolCalls = state.pendingToolCalls.length > 0 ? [...state.pendingToolCalls] : undefined;
      toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
      state.pendingToolCalls = [];
    }

    const liveMessage: InboxMessage = {
      from: state.memberName,
      text: body,
      timestamp: messageTimestamp,
      read: true,
      summary: body.length > 60 ? `${body.slice(0, 57)}...` : body,
      messageId,
      source: 'lead_process',
      ...(toolSummary ? { toolSummary } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
    this.deps.liveLeadMessages.push(
      state.identity,
      liveMessage,
      state.detectedSessionId
    );

    const now = this.nowMs();
    if (now - state.lastEmitMs >= this.emitThrottleMs) {
      state.lastEmitMs = now;
      this.deps.notifyLeadMessage?.(state.identity.teamName, state.identity.runId);
    }
  }

  private readTimestamp(message: Record<string, unknown>): string {
    const raw = typeof message.timestamp === 'string' ? message.timestamp.trim() : '';
    if (raw && Number.isFinite(Date.parse(raw))) return raw;
    return this.nowIso();
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private nowIso(): string {
    return this.deps.nowIso?.() ?? new Date().toISOString();
  }
}
