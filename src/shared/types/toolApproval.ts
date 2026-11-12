import type { TeamProviderId } from './team';

// =============================================================================
// Tool Approval (control_request / control_response protocol)
// =============================================================================

/** A pending tool approval request from the CLI control_request protocol. */
export interface ToolApprovalRequest {
  requestId: string;
  /** Run ID — prevents stale approvals after stop→launch race. */
  runId: string;
  teamName: string;
  /** Runtime/provider that owns the approval, when it is not the Anthropic CLI control protocol. */
  providerId?: TeamProviderId;
  /** Which process sent this (e.g. 'lead'). */
  source: string;
  /** Tool name: 'Bash', 'Edit', 'Write', 'Read', etc. */
  toolName: string;
  /** Tool input parameters (e.g. { command: "ls" } for Bash). */
  toolInput: Record<string, unknown>;
  /** ISO timestamp when the request was received. */
  receivedAt: string;
  /** Team color name (from config or create request) for badge rendering. */
  teamColor?: string;
  /** Team display name (from config or create request). */
  teamDisplayName?: string;
  /** Provider runtime permission metadata used to answer non-Anthropic approval APIs. */
  runtimePermission?: {
    providerId: 'anthropic' | 'opencode' | 'codex';
    laneId: string;
    memberName: string;
    providerRequestId: string;
    sessionId?: string | null;
  };
  /** Permission suggestions from teammate runtime (only for teammate permission_request).
   * FACT: Populated by Claude Code runtime, contains instructions to add permission rules.
   */
  permissionSuggestions?: {
    type: string;
    rules?: { toolName: string }[];
    behavior?: string;
    destination?: string;
  }[];
}

/** Dismissal event — process died, all pending approvals for this team+run should be removed. */
export interface ToolApprovalDismiss {
  dismissed: true;
  teamName: string;
  /** Only dismiss approvals from this specific run. */
  runId: string;
}

// ---------------------------------------------------------------------------
// Tool Approval Settings
// ---------------------------------------------------------------------------

/** Timeout behavior for unanswered tool approval requests. */
export type ToolApprovalTimeoutAction = 'allow' | 'deny' | 'wait';

/** User-configurable auto-allow settings for tool approval. */
export interface ToolApprovalSettings {
  /** Auto-allow ALL tools (overrides individual settings below). */
  autoAllowAll: boolean;
  /** Auto-allow file edit tools (Edit, Write, NotebookEdit). */
  autoAllowFileEdits: boolean;
  /** Auto-allow safe bash commands (git, pnpm, npm, ls, cat, echo, etc.). */
  autoAllowSafeBash: boolean;
  /** Timeout behavior when user doesn't respond. */
  timeoutAction: ToolApprovalTimeoutAction;
  /** Timeout seconds (used when timeoutAction !== 'wait'). */
  timeoutSeconds: number;
}

export const DEFAULT_TOOL_APPROVAL_SETTINGS: ToolApprovalSettings = {
  autoAllowAll: false,
  autoAllowFileEdits: false,
  autoAllowSafeBash: false,
  timeoutAction: 'wait',
  timeoutSeconds: 30,
};

/** Event pushed when a pending approval was auto-resolved (timeout or auto-allow). */
export interface ToolApprovalAutoResolved {
  autoResolved: true;
  requestId: string;
  runId: string;
  teamName: string;
  /** Explicit runtime decision; absent when the runtime only reports resolution. */
  allowed?: boolean;
  reason: 'auto_allow_category' | 'timeout_allow' | 'timeout_deny' | 'runtime_resolved';
}

/** Union of approval events pushed from main to renderer. */
export type ToolApprovalEvent =
  | ToolApprovalRequest
  | ToolApprovalDismiss
  | ToolApprovalAutoResolved;

/** Result of reading a file for tool approval diff preview. */
export interface ToolApprovalFileContent {
  content: string;
  exists: boolean;
  truncated: boolean;
  isBinary: boolean;
  error?: string;
}
