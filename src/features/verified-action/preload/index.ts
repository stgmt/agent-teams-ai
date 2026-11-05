import {
  VERIFIED_ACTION_APPROVE,
  VERIFIED_ACTION_DECIDE,
  VERIFIED_ACTION_LIST,
  VERIFIED_ACTION_PREPARE,
} from '../contracts';

import type { VerifiedAction, VerifiedActionDecision } from '../contracts';
import type { IpcRenderer } from 'electron';

export interface VerifiedActionElectronApi {
  list(teamName: string, taskId: string): Promise<VerifiedAction[]>;
  prepare(teamName: string, taskId: string): Promise<VerifiedAction>;
  approve(id: string): Promise<VerifiedAction>;
  decide(id: string, decision: VerifiedActionDecision): Promise<VerifiedAction>;
}

export function createVerifiedActionBridge(ipc: IpcRenderer): VerifiedActionElectronApi {
  return {
    list: (teamName, taskId) => ipc.invoke(VERIFIED_ACTION_LIST, teamName, taskId),
    prepare: (teamName, taskId) => ipc.invoke(VERIFIED_ACTION_PREPARE, teamName, taskId),
    approve: (id) => ipc.invoke(VERIFIED_ACTION_APPROVE, id),
    decide: (id, decision) => ipc.invoke(VERIFIED_ACTION_DECIDE, id, decision),
  };
}
