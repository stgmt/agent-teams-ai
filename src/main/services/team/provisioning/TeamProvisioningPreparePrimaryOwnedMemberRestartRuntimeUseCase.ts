import {
  killTmuxPaneForCurrentPlatformSync,
  listRuntimeProcessTableForCurrentPlatform,
  listTmuxPanePidsForCurrentPlatform,
  listTmuxPaneRuntimeInfoForCurrentPlatform,
} from '@features/tmux-installer/main';
import { isProcessAlive } from '@main/utils/processHealth';
import { createLogger } from '@shared/utils/logger';

import { commandArgEquals } from '../TeamRuntimeLivenessResolver';

import { isInteractiveShellCommand } from './TeamProvisioningDirectRestart';
import { matchesMemberNameOrBase } from './TeamProvisioningMemberIdentity';
import {
  inspectMemberProcess,
  type ProcessInspection,
  terminateMemberProcess,
} from './TeamProvisioningMemberProcessControl';

const logger = createLogger('Service:TeamProvisioning');

export interface PrimaryOwnedMemberRestartPersistedRuntimeMember {
  name?: string;
  tmuxPaneId?: string;
  backendType?: string;
  runtimePid?: number;
}

export interface PrimaryOwnedMemberRestartLiveRuntimeMetadata {
  alive?: boolean;
  backendType?: string;
  pid?: number;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeInput {
  teamName: string;
  memberName: string;
  persistedRuntimeMembers: readonly PrimaryOwnedMemberRestartPersistedRuntimeMember[];
  assertStillCurrent?(): void;
  invalidateRuntimeSnapshotCaches(): void;
  loadLiveRuntimeByMember(): Promise<
    ReadonlyMap<string, PrimaryOwnedMemberRestartLiveRuntimeMetadata>
  >;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeResult {
  directTmuxRestartPaneId: string | null;
  shouldDirectProcessRestart: boolean;
}

export interface PrimaryOwnedMemberRestartTmuxPaneRuntimeInfo {
  panePid: number;
  currentCommand?: string;
}

export interface PrimaryOwnedMemberRestartRuntimeProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts {
  listTmuxPaneRuntimeInfo(
    paneIds: readonly string[]
  ): Promise<Map<string, PrimaryOwnedMemberRestartTmuxPaneRuntimeInfo>>;
  listRuntimeProcesses(options: {
    bypassCache: boolean;
  }): Promise<readonly PrimaryOwnedMemberRestartRuntimeProcessRow[] | null>;
  isProcessAlive(pid: number): boolean;
  /** Asynchronous lookup of a process command line; `unreadable` means the lookup failed. */
  inspectProcess(pid: number): Promise<ProcessInspection>;
  killTmuxPane(paneId: string): void;
  /** Terminates the process tree and resolves only after the pid is gone; rejects otherwise. */
  terminateProcess(pid: number): Promise<void>;
  waitForTmuxPanesToExit(
    paneIds: readonly string[],
    options: { timeoutMs: number; pollMs: number }
  ): Promise<string[]>;
  logInfo(message: string): void;
  logDebug(message: string): void;
  logDiagnostic(message: string): void;
  logWarning(message: string): void;
}

export type PreparePrimaryOwnedMemberRestartRuntimeUseCase = (
  input: PreparePrimaryOwnedMemberRestartRuntimeInput
) => Promise<PreparePrimaryOwnedMemberRestartRuntimeResult>;

export function createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase(): PreparePrimaryOwnedMemberRestartRuntimeUseCase {
  return createPreparePrimaryOwnedMemberRestartRuntimeUseCase({
    listTmuxPaneRuntimeInfo: (paneIds) => listTmuxPaneRuntimeInfoForCurrentPlatform(paneIds),
    listRuntimeProcesses: (options) => listRuntimeProcessTableForCurrentPlatform(options),
    isProcessAlive,
    inspectProcess: inspectMemberProcess,
    killTmuxPane: (paneId) => killTmuxPaneForCurrentPlatformSync(paneId),
    terminateProcess: terminateMemberProcess,
    waitForTmuxPanesToExit,
    logInfo: (message) => logger.info(message),
    logDebug: (message) => logger.debug(message),
    logDiagnostic: (message) => logger.diagnostic(message),
    logWarning: (message) => logger.warn(message),
  });
}

export function createPreparePrimaryOwnedMemberRestartRuntimeUseCase(
  ports: PreparePrimaryOwnedMemberRestartRuntimeUseCasePorts
): PreparePrimaryOwnedMemberRestartRuntimeUseCase {
  return async (input) => {
    const targetMemberName = input.memberName.trim();
    const targetPersistedRuntimeMembers = input.persistedRuntimeMembers.filter((member) => {
      const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
      return candidateName.length > 0 && matchesMemberNameOrBase(candidateName, targetMemberName);
    });
    const backendTypes = new Set(
      targetPersistedRuntimeMembers
        .map((member) => member.backendType?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    if (backendTypes.has('in-process')) {
      throw new Error(
        `Member "${input.memberName}" uses an in-process runtime and cannot be restarted here`
      );
    }

    input.assertStillCurrent?.();
    input.invalidateRuntimeSnapshotCaches();
    const liveRuntimeByMember = await input.loadLiveRuntimeByMember();
    input.assertStillCurrent?.();

    const livePids = new Set<number>();
    let hasAliveRuntimeWithoutPid = false;
    for (const [candidateName, metadata] of liveRuntimeByMember.entries()) {
      if (!matchesMemberNameOrBase(candidateName, input.memberName)) {
        continue;
      }
      if (metadata.backendType?.trim().toLowerCase() === 'in-process') {
        throw new Error(
          `Member "${input.memberName}" uses an in-process runtime and cannot be restarted here`
        );
      }
      if (metadata.pid) {
        livePids.add(metadata.pid);
        continue;
      }
      if (metadata.alive) {
        hasAliveRuntimeWithoutPid = true;
      }
    }

    if (hasAliveRuntimeWithoutPid) {
      throw new Error(
        `Member "${input.memberName}" is running, but its backend does not expose a restartable pid yet`
      );
    }

    const tmuxRuntimeMembers = targetPersistedRuntimeMembers.flatMap((member) => {
      const paneId = typeof member.tmuxPaneId === 'string' ? member.tmuxPaneId.trim() : '';
      const concreteMemberName = typeof member.name === 'string' ? member.name.trim() : '';
      return paneId &&
        concreteMemberName &&
        member.backendType?.trim().toLowerCase() === 'tmux' &&
        matchesMemberNameOrBase(concreteMemberName, targetMemberName)
        ? [{ member, paneId, concreteMemberName }]
        : [];
    });
    let directTmuxRestartPaneId: string | null = null;
    const directTmuxRestartCandidatePaneId = tmuxRuntimeMembers[0]?.paneId ?? null;
    if (directTmuxRestartCandidatePaneId) {
      try {
        const paneInfo = (
          await ports.listTmuxPaneRuntimeInfo([directTmuxRestartCandidatePaneId])
        ).get(directTmuxRestartCandidatePaneId);
        if (paneInfo && isInteractiveShellCommand(paneInfo.currentCommand)) {
          directTmuxRestartPaneId = directTmuxRestartCandidatePaneId;
        }
      } catch (error) {
        ports.logDebug(
          `[${input.teamName}] Direct tmux restart probe failed for ${input.memberName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    input.assertStillCurrent?.();

    const hasExactRuntimeIdentity = (command: string | null, concreteMemberName: string): boolean =>
      commandArgEquals(command ?? '', '--team-name', input.teamName) &&
      (commandArgEquals(command ?? '', '--agent-name', concreteMemberName) ||
        commandArgEquals(command ?? '', '--agent-id', `${concreteMemberName}@${input.teamName}`));

    const tmuxPaneIdsToVerify: string[] = [];
    if (!directTmuxRestartPaneId) {
      const paneIds = [...new Set(tmuxRuntimeMembers.map(({ paneId }) => paneId))];
      const paneInfoById: ReadonlyMap<string, PrimaryOwnedMemberRestartTmuxPaneRuntimeInfo> =
        paneIds.length > 0 ? await ports.listTmuxPaneRuntimeInfo(paneIds) : new Map();
      const processRows =
        paneInfoById.size > 0
          ? await ports.listRuntimeProcesses({ bypassCache: true })
          : ([] as const);
      const childrenByParent = new Map<number, PrimaryOwnedMemberRestartRuntimeProcessRow[]>();
      for (const row of processRows ?? []) {
        const children = childrenByParent.get(row.ppid) ?? [];
        children.push(row);
        childrenByParent.set(row.ppid, children);
      }
      input.assertStillCurrent?.();

      for (const {
        member: persistedRuntimeMember,
        paneId,
        concreteMemberName,
      } of tmuxRuntimeMembers) {
        const paneInfo = paneInfoById.get(paneId);
        if (!paneInfo) {
          continue;
        }
        const persistedRuntimePid = persistedRuntimeMember.runtimePid;
        const paneInspection = await ports.inspectProcess(paneInfo.panePid);
        let verifiedRuntimePid =
          paneInspection.status === 'found' &&
          hasExactRuntimeIdentity(paneInspection.command, concreteMemberName) &&
          (typeof persistedRuntimePid !== 'number' || persistedRuntimePid === paneInfo.panePid)
            ? paneInfo.panePid
            : undefined;
        if (verifiedRuntimePid == null) {
          const queue = [...(childrenByParent.get(paneInfo.panePid) ?? [])];
          const seen = new Set<number>();
          while (queue.length > 0) {
            const row = queue.shift();
            if (!row || seen.has(row.pid)) continue;
            seen.add(row.pid);
            if (
              hasExactRuntimeIdentity(row.command, concreteMemberName) &&
              (typeof persistedRuntimePid !== 'number' || persistedRuntimePid === row.pid)
            ) {
              verifiedRuntimePid = row.pid;
              break;
            }
            queue.push(...(childrenByParent.get(row.pid) ?? []));
          }
        }
        if (verifiedRuntimePid == null) {
          ports.logWarning(
            `[${input.teamName}] Refusing to kill teammate pane ${concreteMemberName} (${paneId}) for manual restart: pane runtime identity does not match the exact team and member.`
          );
          continue;
        }
        tmuxPaneIdsToVerify.push(paneId);
        try {
          ports.killTmuxPane(paneId);
          ports.logInfo(
            `[${input.teamName}] Killed teammate pane ${concreteMemberName} (${paneId}) for manual restart`
          );
        } catch (error) {
          ports.logDebug(
            `[${input.teamName}] Failed to kill teammate pane ${concreteMemberName} (${paneId}) for manual restart: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    // A persisted process pid is a stop handle even when the live runtime table was unavailable;
    // without it the old process would survive next to the new one.
    for (const persisted of targetPersistedRuntimeMembers) {
      const pid = persisted.runtimePid;
      const concreteMemberName = typeof persisted.name === 'string' ? persisted.name.trim() : '';
      if (
        persisted.backendType?.trim().toLowerCase() !== 'process' ||
        typeof pid !== 'number' ||
        !Number.isFinite(pid) ||
        pid <= 0 ||
        livePids.has(pid)
      ) {
        continue;
      }
      const inspection = await ports.inspectProcess(pid);
      ports.logDiagnostic(
        `[${input.teamName}] Restart for teammate "${input.memberName}": identity of pid=${pid} is ${inspection.status}`
      );
      if (inspection.status === 'unreadable') {
        throw new Error(
          `Restart for teammate "${input.memberName}" cannot verify the persisted runtime identity of pid ${pid} (the process list could not be read): ${inspection.cause}`
        );
      }
      if (
        inspection.status === 'found' &&
        hasExactRuntimeIdentity(inspection.command, concreteMemberName)
      ) {
        livePids.add(pid);
      } else if (ports.isProcessAlive(pid)) {
        ports.logWarning(
          `[${input.teamName}] Ignoring persisted pid=${pid} for ${input.memberName} on manual restart: process identity does not match the exact team and member.`
        );
      }
    }
    input.assertStillCurrent?.();

    if (livePids.size > 0) {
      const pids = [...livePids];
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
          `Restart for teammate "${input.memberName}" could not stop the previous process: ${failures.join('; ')}`
        );
      }
      ports.logDiagnostic(
        `[${input.teamName}] Restart for teammate "${input.memberName}": stopped pid=${pids.join(',')} in ${Date.now() - startedAt} ms`
      );
    }

    if (tmuxPaneIdsToVerify.length > 0) {
      let lingeringPaneIds: string[];
      try {
        lingeringPaneIds = await ports.waitForTmuxPanesToExit(tmuxPaneIdsToVerify, {
          timeoutMs: 1_500,
          pollMs: 100,
        });
      } catch (error) {
        throw new Error(
          `Restart for teammate "${input.memberName}" could not verify that the previous tmux pane exited: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (lingeringPaneIds.length > 0) {
        throw new Error(
          `Restart for teammate "${input.memberName}" is still waiting for the previous tmux pane to exit (${lingeringPaneIds.join(', ')}).`
        );
      }
    }

    return {
      directTmuxRestartPaneId,
      shouldDirectProcessRestart: backendTypes.has('process') || livePids.size > 0,
    };
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
