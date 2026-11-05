import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../contracts';

import type { VerifiedAction, VerifiedActionDecision } from '../contracts';
import type { IpcRenderer } from 'electron';

export interface VerifiedActionElectronApi {
  list(contextId: string, teamName: string, taskId: string): Promise<VerifiedAction[]>;
  prepare(contextId: string, teamName: string, taskId: string): Promise<VerifiedAction>;
  approve(contextId: string, id: string): Promise<VerifiedAction>;
  decide(contextId: string, id: string, decision: VerifiedActionDecision): Promise<VerifiedAction>;
}

export function createVerifiedActionBridge(ipc: IpcRenderer): VerifiedActionElectronApi {
  return {
    list: (contextId, teamName, taskId) =>
      ipc.invoke(VERIFIED_ACTION_LIST, contextId, teamName, taskId),
    prepare: (contextId, teamName, taskId) =>
      ipc.invoke(VERIFIED_ACTION_PREPARE, contextId, teamName, taskId),
    approve: (contextId, id) => ipc.invoke(VERIFIED_ACTION_APPROVE, contextId, id),
    decide: (contextId, id, decision) =>
      ipc.invoke(VERIFIED_ACTION_DECIDE, contextId, id, decision),
  };
}
