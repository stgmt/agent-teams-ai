import { isOpenCodeServeCommand } from '@main/services/team/opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { readProcessCommandByPid } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeLaneCleanup';
import {
  rememberOpenCodeRuntimePidFromBridge as rememberPidFromBridge,
  type RememberOpenCodeRuntimePidFromBridgePorts,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePidBridge';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';

import type { TeamChangeEvent } from '@shared/types';

/**
 * The runtime's process id, recorded against the member it belongs to.
 *
 * The bridge reports the id of the process it started; the launch snapshot is
 * where a later stop, probe or clean-up looks for it. Recording it is only safe
 * while the process is still the OpenCode host the bridge claims - an id that
 * was reused by something else would be killed as if it were the runtime - so
 * the command line is re-read before anything is written.
 */
export interface NativeOpenCodeRuntimePidMemoryDependencies {
  store: Pick<TeamLaunchStateStore, 'read' | 'write'>;
  /** Snapshot caches keyed by team; the newly recorded pid makes them stale. */
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  /** The UI re-reads the team after its launch state changed. */
  emitTeamChange(event: TeamChangeEvent): void;
  logDebug(message: string): void;
  now?(): string;
  /** Command line of a running process; the process table unless a caller proves otherwise. */
  readProcessCommand?(pid: number): string | null | undefined;
}

export interface NativeOpenCodeRuntimePidMemory {
  rememberRuntimePidFromBridge(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    runId?: string | null;
    runtimeSessionId?: string | null;
    runtimePid?: number;
    reason: string;
  }): Promise<void>;
}

/**
 * Recording a pid is a read-modify-write of the whole snapshot, so two members
 * reporting at once would drop one of the entries. The store's own publication
 * queue cannot be re-entered from inside it, so the read and the write that
 * belongs with it are serialized here, per team.
 */
function createSerialRun(): <T>(teamName: string, operation: () => Promise<T>) => Promise<T> {
  const tailByTeam = new Map<string, Promise<void>>();
  return (teamName, operation) => {
    const previous = tailByTeam.get(teamName) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const tail = queued.then(
      () => undefined,
      () => undefined
    );
    tailByTeam.set(teamName, tail);
    void tail.then(() => {
      if (tailByTeam.get(teamName) === tail) tailByTeam.delete(teamName);
    });
    return queued;
  };
}

export function createNativeOpenCodeRuntimePidMemory(
  deps: NativeOpenCodeRuntimePidMemoryDependencies
): NativeOpenCodeRuntimePidMemory {
  const serialize = createSerialRun();
  const ports: RememberOpenCodeRuntimePidFromBridgePorts = {
    nowIso: () => deps.now?.() ?? new Date().toISOString(),
    readProcessCommandByPid: (pid) => deps.readProcessCommand?.(pid) ?? readProcessCommandByPid(pid),
    isOpenCodeServeCommand,
    enqueueLaunchStateStoreOperation: (teamName, operation) => serialize(teamName, operation),
    readLaunchState: (teamName) => deps.store.read(teamName),
    writeLaunchStateSnapshot: async (teamName, snapshot, options) => {
      const wrote = await deps.store.write(teamName, snapshot, options);
      // A superseded publication means another launch owns the snapshot now;
      // reporting success here would claim a pid nobody recorded.
      if (!wrote) throw new Error('OpenCode runtime PID publication was superseded');
    },
    invalidateRuntimeSnapshotCaches: (teamName) => deps.invalidateRuntimeSnapshotCaches(teamName),
    emitTeamChange: (event) => deps.emitTeamChange(event),
    logDebug: (message) => deps.logDebug(message),
  };

  return {
    rememberRuntimePidFromBridge: (input) => rememberPidFromBridge(input, ports),
  };
}
