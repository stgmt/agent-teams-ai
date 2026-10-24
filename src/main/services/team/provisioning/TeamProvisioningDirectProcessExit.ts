import { buildMemberSpawnStatusTransition } from './TeamProvisioningMemberSpawnTransitions';
import { mergeRuntimeDiagnostics } from './TeamProvisioningRuntimeMetadata';
import {
  describeMemberProcessExited,
  type LiveTeamAgentRuntimeMetadata,
} from './TeamProvisioningRuntimeMetadataPolicy';

import type { MemberSpawnStatusEntry, TeamAgentRuntimeBackendType } from '@shared/types';

/**
 * The recorded pid of a confirmed direct-process teammate, when the OS says it is gone.
 *
 * Only the pid probe proves this: the shared process table cannot, because on Windows it is WSL's
 * `ps` (another pid namespace). A process found by team and agent id (`runtime_process`) means the
 * agent runs under another pid, so it is not declared dead. A teammate without a confirmed
 * bootstrap is already reported as not running and is left to the launch flow.
 */
export function findProvenExitedDirectProcessPid(params: {
  isOpenCodeLaneMember: boolean;
  backendType: TeamAgentRuntimeBackendType | undefined;
  tmuxPaneId: string | undefined;
  recordedPid: number | undefined;
  hasConfirmedBootstrap: boolean;
  verifiedProcessFound: boolean;
  isRuntimePidAlive(pid: number): boolean;
}): number | undefined {
  const isDirectProcess =
    params.backendType === 'process' || params.tmuxPaneId?.trim().startsWith('process:') === true;
  if (
    params.isOpenCodeLaneMember ||
    !isDirectProcess ||
    params.recordedPid === undefined ||
    !params.hasConfirmedBootstrap ||
    params.verifiedProcessFound
  ) {
    return undefined;
  }
  return params.isRuntimePidAlive(params.recordedPid) ? undefined : params.recordedPid;
}

/** The live metadata of a teammate whose recorded process the OS no longer has. */
export function buildProcessExitedRuntimeMetadata(
  metadata: LiveTeamAgentRuntimeMetadata,
  exitedPid: number,
  resolvedDiagnostics: string[] | undefined
): LiveTeamAgentRuntimeMetadata {
  const exitedDiagnostic = describeMemberProcessExited(exitedPid);
  return {
    ...metadata,
    alive: false,
    pid: exitedPid,
    metricsPid: exitedPid,
    livenessKind: 'stale_metadata',
    pidSource: 'persisted_metadata',
    processExited: true,
    runtimeDiagnostic: exitedDiagnostic,
    runtimeDiagnosticSeverity: 'warning',
    diagnostics: mergeRuntimeDiagnostics(resolvedDiagnostics, [exitedDiagnostic]),
  };
}

/**
 * A teammate whose bootstrap was confirmed but whose recorded process the OS no longer has.
 * A fresh heartbeat or an old confirmation does not revive it: the process that sent them is gone.
 */
export function buildProcessExitedStatusEntry(
  current: MemberSpawnStatusEntry,
  metadata: LiveTeamAgentRuntimeMetadata,
  checkedAt: string
): MemberSpawnStatusEntry {
  const { next } = buildMemberSpawnStatusTransition({
    previous: current,
    requestedStatus: 'offline',
    updatedAt: checkedAt,
  });
  return {
    ...next,
    ...(metadata.model ? { runtimeModel: metadata.model } : {}),
    livenessKind: 'stale_metadata',
    runtimeDiagnostic:
      metadata.runtimeDiagnostic ?? describeMemberProcessExited(metadata.metricsPid ?? 0),
    runtimeDiagnosticSeverity: 'warning',
    livenessLastCheckedAt: checkedAt,
  };
}
