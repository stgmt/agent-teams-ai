import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
  buildTeammatePermissionUpdatedInput,
} from '@main/services/team/provisioning/TeamProvisioningToolApprovalFlow';

import type { MemberProcessToken, TeamRunIdentity } from '../../../contracts';
import type { NativeClaudeSdkOutputEvidence } from './NativeClaudeSdkHost';

export interface NativeClaudeApproval {
  run: Readonly<TeamRunIdentity>;
  token: Readonly<MemberProcessToken>;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  receivedAt: string;
}

export type NativeToolApprovalEvent =
  | { type: 'requested'; approval: NativeClaudeApproval }
  | { type: 'resolved'; runId: string; requestId: string; allow: boolean }
  | { type: 'dismissed'; runId: string; teamName: string }
  | { type: 'error'; runId: string; message: string };

export type ParsedClaudeControlRequest =
  | {
      kind: 'tool';
      requestId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }
  | { kind: 'other'; requestId: string }
  | null;

/** Claude CLI control requests arrive as JSON lines on stdout. */
export function parseClaudeControlRequest(line: string): ParsedClaudeControlRequest {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'control_request') return null;
  const requestId = typeof value.request_id === 'string' ? value.request_id : null;
  if (!requestId) return null;
  const request =
    value.request && typeof value.request === 'object' && !Array.isArray(value.request)
      ? (value.request as Record<string, unknown>)
      : {};
  if (request.subtype !== 'can_use_tool') return { kind: 'other', requestId };
  const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'Unknown';
  const toolInput =
    request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? (request.input as Record<string, unknown>)
      : {};
  return { kind: 'tool', requestId, toolName, toolInput };
}

export class NativeClaudeApprovalStore {
  private readonly pending = new Map<string, NativeClaudeApproval>();

  register(
    token: Readonly<MemberProcessToken>,
    request: ParsedClaudeControlRequest
  ): NativeClaudeApproval | null {
    if (request?.kind !== 'tool') return null;
    const approval: NativeClaudeApproval = {
      run: Object.freeze({
        appInstanceId: token.appInstanceId,
        dataRootFingerprint: token.dataRootFingerprint,
        connectionGeneration: token.connectionGeneration,
        teamName: token.teamName,
        runId: token.runId,
      }),
      token,
      requestId: request.requestId,
      toolName: request.toolName,
      toolInput: request.toolInput,
      receivedAt: new Date().toISOString(),
    };
    this.pending.set(`${token.runId}:${request.requestId}`, approval);
    return approval;
  }

  list(runId: string): readonly NativeClaudeApproval[] {
    return [...this.pending.values()].filter((approval) => approval.run.runId === runId);
  }

  take(runId: string, requestId: string): NativeClaudeApproval | null {
    const key = `${runId}:${requestId}`;
    const approval = this.pending.get(key) ?? null;
    this.pending.delete(key);
    return approval;
  }

  resolveConsumed(
    token: Readonly<MemberProcessToken>,
    requestId: string
  ): NativeClaudeApproval | null {
    const key = `${token.runId}:${requestId}`;
    const approval = this.pending.get(key);
    if (
      !approval ||
      approval.token.memberName !== token.memberName ||
      approval.token.teamName !== token.teamName ||
      approval.token.generation !== token.generation ||
      approval.token.operationId !== token.operationId ||
      approval.token.appInstanceId !== token.appInstanceId ||
      approval.token.dataRootFingerprint !== token.dataRootFingerprint ||
      approval.token.connectionGeneration !== token.connectionGeneration
    )
      return null;
    this.pending.delete(key);
    return approval;
  }

  clearRun(runId: string): void {
    for (const [key, approval] of this.pending) {
      if (approval.run.runId === runId) this.pending.delete(key);
    }
  }
}

interface NativeClaudeToolApprovalsDependencies {
  store: NativeClaudeApprovalStore;
  write(token: Readonly<MemberProcessToken>, line: string): Promise<void>;
}

/** Ingests control requests and answers them through the owned member stdin. */
export class NativeClaudeToolApprovals {
  private readonly listeners = new Set<(event: NativeToolApprovalEvent) => void>();

  constructor(private readonly deps: NativeClaudeToolApprovalsDependencies) {}

  onEvent(listener: (event: NativeToolApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observeLine(
    token: Readonly<MemberProcessToken>,
    line: string,
    evidence?: NativeClaudeSdkOutputEvidence
  ): void {
    if (evidence?.permissionResponseConsumed) {
      const event = JSON.parse(line) as {
        type?: string;
        response?: {
          subtype?: string;
          request_id?: string;
          response?: { behavior?: string };
        };
      };
      const response = event.response;
      if (
        event.type === 'control_response' &&
        response?.subtype === 'success' &&
        typeof response.request_id === 'string' &&
        (response.response?.behavior === 'allow' || response.response?.behavior === 'deny')
      ) {
        const approval = this.deps.store.resolveConsumed(token, response.request_id);
        if (approval)
          this.emit({
            type: 'resolved',
            runId: token.runId,
            requestId: response.request_id,
            allow: response.response.behavior === 'allow',
          });
      }
      return;
    }
    const request = parseClaudeControlRequest(line);
    if (!request) return;
    if (request.kind === 'tool') {
      const approval = this.deps.store.register(token, request);
      if (approval) this.emit({ type: 'requested', approval });
      return;
    }
    // Non-tool subtypes (hooks) must not deadlock the CLI.
    void this.deps
      .write(token, JSON.stringify(buildAllowControlResponsePayload(request.requestId)))
      .catch((error: unknown) =>
        this.emit({
          type: 'error',
          runId: token.runId,
          message: error instanceof Error ? error.message : String(error),
        })
      );
  }

  list(runId: string): readonly NativeClaudeApproval[] {
    return this.deps.store.list(runId);
  }

  async respond(
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<boolean> {
    const approval = this.deps.store.take(runId, requestId);
    if (!approval) return false;
    const payload = allow
      ? buildAllowControlResponsePayload(requestId, {
          behavior: 'allow',
          updatedInput:
            buildTeammatePermissionUpdatedInput(approval.toolName, approval.toolInput, message) ??
            {},
        })
      : buildDenyControlResponsePayload(requestId, message ?? 'User denied');
    try {
      await this.deps.write(approval.token, JSON.stringify(payload));
    } catch (error) {
      // An unknown SDK outcome must not erase the pending request.
      this.deps.store.register(approval.token, {
        kind: 'tool',
        requestId: approval.requestId,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
      });
      throw error;
    }
    this.emit({ type: 'resolved', runId, requestId, allow });
    return true;
  }

  clearRun(runId: string): void {
    const pending = this.deps.store.list(runId);
    this.deps.store.clearRun(runId);
    if (pending.length) {
      this.emit({ type: 'dismissed', runId, teamName: pending[0].run.teamName });
    }
  }

  private emit(event: NativeToolApprovalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
