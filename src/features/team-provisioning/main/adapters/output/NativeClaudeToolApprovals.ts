import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
} from '@main/services/team/provisioning/TeamProvisioningToolApprovalFlow';

import type { MemberProcessToken, TeamRunIdentity } from '../../../contracts';

export interface NativeClaudeApproval {
  run: Readonly<TeamRunIdentity>;
  token: Readonly<MemberProcessToken>;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  receivedAt: string;
}

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

  register(token: Readonly<MemberProcessToken>, request: ParsedClaudeControlRequest): boolean {
    if (request?.kind !== 'tool') return false;
    this.pending.set(`${token.runId}:${request.requestId}`, {
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
    });
    return true;
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
  constructor(private readonly deps: NativeClaudeToolApprovalsDependencies) {}

  observeLine(token: Readonly<MemberProcessToken>, line: string): void {
    const request = parseClaudeControlRequest(line);
    if (!request) return;
    if (request.kind === 'tool') {
      this.deps.store.register(token, request);
      return;
    }
    // Non-tool subtypes (hooks) must not deadlock the CLI.
    void this.deps
      .write(token, JSON.stringify(buildAllowControlResponsePayload(request.requestId)))
      .catch(() => undefined);
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
      ? buildAllowControlResponsePayload(requestId)
      : buildDenyControlResponsePayload(requestId, message ?? 'User denied');
    try {
      await this.deps.write(approval.token, JSON.stringify(payload));
    } catch (error) {
      // A failed stdin write must not erase the pending request.
      this.deps.store.register(approval.token, {
        kind: 'tool',
        requestId: approval.requestId,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
      });
      throw error;
    }
    return true;
  }

  clearRun(runId: string): void {
    this.deps.store.clearRun(runId);
  }
}
