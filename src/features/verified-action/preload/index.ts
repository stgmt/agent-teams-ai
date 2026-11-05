import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_FENCE_DECISION,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../contracts';

import type {
  VerifiedAction,
  VerifiedActionDecision,
  VerifiedActionFenceResult,
} from '../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { IpcRenderer } from 'electron';

export interface VerifiedActionElectronApi {
  list(
    contextId: string,
    expected: AppConnectionContext,
    expectedRootFingerprint: string,
    teamName: string,
    taskId: string
  ): Promise<VerifiedAction[]>;
  prepare(
    contextId: string,
    expected: AppConnectionContext,
    expectedRootFingerprint: string,
    teamName: string,
    taskId: string
  ): Promise<VerifiedAction>;
  approve(
    contextId: string,
    expected: AppConnectionContext,
    expectedRootFingerprint: string,
    id: string
  ): Promise<VerifiedAction>;
  decide(
    contextId: string,
    expected: AppConnectionContext,
    expectedRootFingerprint: string,
    id: string,
    decision: VerifiedActionDecision,
    decisionId: string
  ): Promise<VerifiedAction>;
  fenceDecision(
    contextId: string,
    expected: AppConnectionContext,
    expectedRootFingerprint: string,
    id: string,
    decision: VerifiedActionDecision,
    decisionId: string
  ): Promise<VerifiedActionFenceResult>;
}

export function createVerifiedActionBridge(ipc: IpcRenderer): VerifiedActionElectronApi {
  return {
    list: (contextId, expected, root, teamName, taskId) =>
      ipc.invoke(VERIFIED_ACTION_LIST, contextId, expected, root, teamName, taskId),
    prepare: (contextId, expected, root, teamName, taskId) =>
      ipc.invoke(VERIFIED_ACTION_PREPARE, contextId, expected, root, teamName, taskId),
    approve: (contextId, expected, root, id) =>
      ipc.invoke(VERIFIED_ACTION_APPROVE, contextId, expected, root, id),
    decide: (contextId, expected, root, id, decision, decisionId) =>
      ipc.invoke(VERIFIED_ACTION_DECIDE, contextId, expected, root, id, decision, decisionId),
    fenceDecision: (contextId, expected, root, id, decision, decisionId) =>
      ipc.invoke(
        VERIFIED_ACTION_FENCE_DECISION,
        contextId,
        expected,
        root,
        id,
        decision,
        decisionId
      ),
  };
}
