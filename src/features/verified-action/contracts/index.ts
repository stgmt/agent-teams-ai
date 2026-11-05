/** A verified task artifact, bound to the exact content approved by the user. */
export interface VerifiedActionProof {
  attachmentId: string;
  sha256: string;
  size: number;
}

export type VerifiedActionStatus =
  | 'awaiting_approval'
  | 'running'
  | 'question'
  | 'stale'
  | 'manual'
  | 'completed';

export type VerifiedActionDecision = 'completed' | 'retry_once' | 'leave_unresolved';

export interface VerifiedAction {
  id: string;
  scope: string;
  teamName: string;
  taskId: string;
  proof: VerifiedActionProof;
  status: VerifiedActionStatus;
  attempts: 0 | 1 | 2;
  completion?: 'queued' | 'user_attested';
  decisionReceipt?: { id: string; decision: VerifiedActionDecision };
  createdAt: string;
  updatedAt: string;
}

export const VERIFIED_ACTION_LIST = 'verified-action:list';
export const VERIFIED_ACTION_PREPARE = 'verified-action:prepare';
export const VERIFIED_ACTION_APPROVE = 'verified-action:approve';
export const VERIFIED_ACTION_DECIDE = 'verified-action:decide';
export const VERIFIED_ACTION_FENCE_DECISION = 'verified-action:fence-decision';
