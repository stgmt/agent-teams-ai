import {
  killTmuxPaneForCurrentPlatformSync,
  listRuntimeProcessTableForCurrentPlatform,
  listTmuxPanePidsForCurrentPlatform,
  listTmuxPaneRuntimeInfoForCurrentPlatform,
} from '@features/tmux-installer/main';
import { isProcessAlive } from '@main/utils/processHealth';
import { createLogger } from '@shared/utils/logger';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import { matchesObservedMemberNameForExpected } from './TeamProvisioningMemberIdentity';
import {
  inspectMemberProcess,
  type ProcessInspection,
  terminateMemberProcess,
} from './TeamProvisioningMemberProcessControl';

const logger = createLogger('Service:TeamProvisioning');

export interface PrimaryOwnedRosterRuntimeMember {
  backendType?: string;
  runtimePid?: number;
  tmuxPaneId?: string;
}

export interface PrimaryOwnedRosterLiveRuntimeMetadata {
  alive?: boolean;
  backendType?: string;
  metricsPid?: number;
  pid?: number;
  tmuxPaneId?: string;
}

export interface PrimaryOwnedRosterTmuxPaneRuntimeInfo {
  panePid: number;
}

export interface PrimaryOwnedRosterRuntimeProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface StopPrimaryOwnedRosterRuntimeInput {
  teamName: string;
  memberName: string;
  persistedRuntimeMembers: readonly PrimaryOwnedRosterRuntimeMember[];
  liveRuntimeByMember: ReadonlyMap<string, PrimaryOwnedRosterLiveRuntimeMetadata>;
  actionLabel: string;
}

export interface StopPrimaryOwnedRosterRuntimeUseCasePorts {
  isProcessAlive(pid: number): boolean;
  /** Asynchronous lookup of a process command line; `unreadable` means the lookup failed. */
  inspectProcess(pid: number): Promise<ProcessInspection>;
  listTmuxPaneRuntimeInfo(
    paneIds: readonly string[]
  ): Promise<ReadonlyMap<string, PrimaryOwnedRosterTmuxPaneRuntimeInfo>>;
  listRuntimeProcesses(options: {
    bypassCache: boolean;
  }): Promise<readonly PrimaryOwnedRosterRuntimeProcessRow[] | null>;
  killTmuxPane(paneId: string): void;
  /** Terminates the process tree and resolves only after the pid is gone; rejects otherwise. */
  terminateProcess(pid: number): Promise<void>;
  waitForTmuxPanesToExit(
    paneIds: readonly string[],
    options: { timeoutMs: number; pollMs: number }
  ): Promise<string[]>;
  logDebug(message: string): void;
  logDiagnostic(message: string): void;
  logWarning(message: string): void;
}

export type StopPrimaryOwnedRosterRuntimeUseCase = (
  input: StopPrimaryOwnedRosterRuntimeInput
) => Promise<void>;

export function createNodeStopPrimaryOwnedRosterRuntimeUseCase(): StopPrimaryOwnedRosterRuntimeUseCase {
  return createStopPrimaryOwnedRosterRuntimeUseCase({
    isProcessAlive,
    inspectProcess: inspectMemberProcess,
    listTmuxPaneRuntimeInfo: (paneIds) => listTmuxPaneRuntimeInfoForCurrentPlatform(paneIds),
    listRuntimeProcesses: (options) => listRuntimeProcessTableForCurrentPlatform(options),
    killTmuxPane: (paneId) => killTmuxPaneForCurrentPlatformSync(paneId),
    terminateProcess: terminateMemberProcess,
    waitForTmuxPanesToExit,
    logDebug: (message) => logger.debug(message),
    logDiagnostic: (message) => logger.diagnostic(message),
    logWarning: (message) => logger.warn(message),
  });
}

export function createStopPrimaryOwnedRosterRuntimeUseCase(
  ports: StopPrimaryOwnedRosterRuntimeUseCasePorts
): StopPrimaryOwnedRosterRuntimeUseCase {
  return async (input) => {
    const pidsToStop = new Set<number>();
    const tmuxPaneIdsToStop = new Set<string>();
    const persistedTmuxPaneIds = new Set(
      input.persistedRuntimeMembers
        .filter((member) => member.backendType?.trim().toLowerCase() === 'tmux')
        .map((member) => (typeof member.tmuxPaneId === 'string' ? member.tmuxPaneId.trim() : ''))
        .filter(Boolean)
    );
    const foreignPids = new Set<number>();
    let hasAliveRuntimeWithoutStopHandle = false;

    let persistedTmuxPaneInfo: ReadonlyMap<string, PrimaryOwnedRosterTmuxPaneRuntimeInfo> =
      new Map();
    if (persistedTmuxPaneIds.size > 0) {
      try {
        persistedTmuxPaneInfo = await ports.listTmuxPaneRuntimeInfo([...persistedTmuxPaneIds]);
      } catch (error) {
        throw new Error(
          `${input.actionLabel} cannot verify the persisted tmux runtime identity: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const hasExactRuntimeIdentity = (command: string | null): boolean =>
      commandArgEquals(command ?? '', '--team-name', input.teamName) &&
      (commandArgEquals(command ?? '', '--agent-name', input.memberName) ||
        commandArgEquals(command ?? '', '--agent-id', `${input.memberName}@${input.teamName}`));

    for (const runtimeMember of input.persistedRuntimeMembers) {
      const backendType = runtimeMember.backendType?.trim().toLowerCase();
      if (backendType === 'in-process') {
        throw new Error(
          `Member "${input.memberName}" uses an in-process runtime and cannot be detached here`
        );
      }
      if (
        backendType === 'process' &&
        typeof runtimeMember.runtimePid === 'number' &&
        Number.isFinite(runtimeMember.runtimePid) &&
        runtimeMember.runtimePid > 0
      ) {
        const pid = runtimeMember.runtimePid;
        const inspection = await ports.inspectProcess(pid);
        ports.logDiagnostic(
          `[${input.teamName}] ${input.actionLabel}: identity of pid=${pid} is ${inspection.status}`
        );
        if (inspection.status === 'unreadable') {
          throw new Error(
            `${input.actionLabel} cannot verify the persisted runtime identity of pid ${pid} (the process list could not be read): ${inspection.cause}`
          );
        }
        if (inspection.status === 'found' && hasExactRuntimeIdentity(inspection.command)) {
          pidsToStop.add(pid);
        } else if (ports.isProcessAlive(pid)) {
          hasAliveRuntimeWithoutStopHandle = true;
          foreignPids.add(pid);
          ports.logWarning(
            `[${input.teamName}] Refusing to stop persisted teammate pid=${pid} for ${input.memberName}: process identity does not match the exact team and member.`
          );
        }
      }
      const paneId =
        typeof runtimeMember.tmuxPaneId === 'string' ? runtimeMember.tmuxPaneId.trim() : '';
      if (backendType === 'tmux' && paneId) {
        const paneInfo = persistedTmuxPaneInfo.get(paneId);
        if (paneInfo) {
          const paneInspection = await ports.inspectProcess(paneInfo.panePid);
          let verifiedRuntimePid =
            paneInspection.status === 'found' && hasExactRuntimeIdentity(paneInspection.command)
              ? paneInfo.panePid
              : undefined;
          if (verifiedRuntimePid == null) {
            const processRows = await ports.listRuntimeProcesses({ bypassCache: true });
            if (processRows) {
              const childrenByParent = new Map<number, PrimaryOwnedRosterRuntimeProcessRow[]>();
              for (const row of processRows) {
                const children = childrenByParent.get(row.ppid) ?? [];
                children.push(row);
                childrenByParent.set(row.ppid, children);
              }
              const queue = [...(childrenByParent.get(paneInfo.panePid) ?? [])];
              const seen = new Set<number>();
              while (queue.length > 0) {
                const row = queue.shift();
                if (!row || seen.has(row.pid)) continue;
                seen.add(row.pid);
                if (
                  hasExactRuntimeIdentity(row.command) &&
                  (typeof runtimeMember.runtimePid !== 'number' ||
                    runtimeMember.runtimePid === row.pid)
                ) {
                  verifiedRuntimePid = row.pid;
                  break;
                }
                queue.push(...(childrenByParent.get(row.pid) ?? []));
              }
            }
          }
          if (verifiedRuntimePid != null) {
            tmuxPaneIdsToStop.add(paneId);
          } else {
            hasAliveRuntimeWithoutStopHandle = true;
            ports.logWarning(
              `[${input.teamName}] Refusing to stop persisted teammate pane=${paneId} for ${input.memberName}: pane runtime identity does not match the exact team and member.`
            );
          }
        }
      }
    }

    for (const [candidateName, metadata] of input.liveRuntimeByMember.entries()) {
      if (!matchesObservedMemberNameForExpected(candidateName, input.memberName)) {
        continue;
      }
      if (metadata.backendType === 'in-process') {
        throw new Error(
          `Member "${input.memberName}" uses an in-process runtime and cannot be detached here`
        );
      }

      let hasStopHandle = false;
      if (metadata.backendType === 'tmux') {
        const paneId = metadata.tmuxPaneId?.trim();
        if (paneId && !persistedTmuxPaneIds.has(paneId)) {
          tmuxPaneIdsToStop.add(paneId);
          hasStopHandle = true;
        } else if (paneId && tmuxPaneIdsToStop.has(paneId)) {
          hasStopHandle = true;
        }
      }
      if (
        metadata.alive &&
        typeof metadata.pid === 'number' &&
        Number.isFinite(metadata.pid) &&
        metadata.pid > 0
      ) {
        pidsToStop.add(metadata.pid);
        hasStopHandle = true;
      }
      if (
        metadata.alive &&
        typeof metadata.metricsPid === 'number' &&
        Number.isFinite(metadata.metricsPid) &&
        metadata.metricsPid > 0
      ) {
        pidsToStop.add(metadata.metricsPid);
        hasStopHandle = true;
      }
      if (metadata.alive && !hasStopHandle) {
        hasAliveRuntimeWithoutStopHandle = true;
      }
    }

    if (hasAliveRuntimeWithoutStopHandle && pidsToStop.size === 0 && tmuxPaneIdsToStop.size === 0) {
      if (foreignPids.size > 0) {
        throw new Error(
          `${input.actionLabel} refuses to stop pid ${[...foreignPids].join(', ')}: the process is not the runtime of this teammate (its command line does not name this team and member).`
        );
      }
      throw new Error(
        `${input.actionLabel} cannot stop the existing runtime because it does not expose a pid or tmux pane.`
      );
    }

    for (const paneId of tmuxPaneIdsToStop) {
      try {
        ports.killTmuxPane(paneId);
      } catch (error) {
        ports.logDebug(
          `[${input.teamName}] Failed to stop teammate pane ${input.memberName} ${paneId} for live roster lifecycle: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    if (pidsToStop.size > 0) {
      const pids = [...pidsToStop];
      const startedAt = Date.now();
      const outcomes = await Promise.allSettled(pids.map((pid) => ports.terminateProcess(pid)));
      const failures = outcomes.flatMap((outcome, index) =>
        outcome.status === 'rejected'
          ? [
              `pid ${pids[index]}: ${
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
              }`,
            ]
          : []
      );
      if (failures.length > 0) {
        throw new Error(
          `${input.actionLabel} could not stop the previous process: ${failures.join('; ')}`
        );
      }
      ports.logDiagnostic(
        `[${input.teamName}] ${input.actionLabel}: stopped pid=${pids.join(',')} in ${Date.now() - startedAt} ms`
      );
    }
    if (tmuxPaneIdsToStop.size > 0) {
      const lingeringPaneIds = await ports.waitForTmuxPanesToExit([...tmuxPaneIdsToStop], {
        timeoutMs: 1_500,
        pollMs: 100,
      });
      if (lingeringPaneIds.length > 0) {
        throw new Error(
          `${input.actionLabel} is still waiting for tmux pane exit (${lingeringPaneIds.join(', ')}).`
        );
      }
    }
  };
}

async function waitForTmuxPanesToExit(
  paneIds: readonly string[],
  options: { timeoutMs: number; pollMs: number }
): Promise<string[]> {
  const uniquePaneIds = [...new Set(paneIds.map((paneId) => paneId.trim()).filter(Boolean))];
  if (uniquePaneIds.length === 0) {
    return [];
  }
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    let paneInfo: Map<string, number>;
    try {
      paneInfo = await listTmuxPanePidsForCurrentPlatform(uniquePaneIds);
    } catch (error) {
      if (isTmuxServerUnavailableError(error)) {
        return [];
      }
      throw error;
    }
    const alive = uniquePaneIds.filter((paneId) => paneInfo.has(paneId));
    if (alive.length === 0) {
      return [];
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
  let finalPaneInfo: Map<string, number>;
  try {
    finalPaneInfo = await listTmuxPanePidsForCurrentPlatform(uniquePaneIds);
  } catch (error) {
    if (isTmuxServerUnavailableError(error)) {
      return [];
    }
    throw error;
  }
  return uniquePaneIds.filter((paneId) => finalPaneInfo.has(paneId));
}

function isTmuxServerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /error connecting to .*tmux.*No such file or directory/i.test(message);
}
