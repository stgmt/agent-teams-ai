import {
  toMemberSpawnStatuses,
  toTeamAgentRuntimeSnapshot,
} from '@main/team-runtime/nativeTeamRuntimeProjection';

import { createNativeRuntimeSurface } from './createNativeRuntimeSurface';

import type { TeamLifecycleSnapshot } from '../../contracts';
import type { NativeDesktopTeamRuntime } from './createNativeDesktopTeamRuntime';
import type {
  TeamHttpHandlerApis,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { MemberSpawnStatusesSnapshot } from '@shared/types';

export interface NativeTeamHttpApisDependencies {
  runtime: NativeDesktopTeamRuntime;
  taskActivity: TeamTaskActivityRepairApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
  now(): string;
}

const EMPTY_STATUSES = (now: string): MemberSpawnStatusesSnapshot => ({
  statuses: {},
  runId: null,
  expectedMembers: [],
  updatedAt: now,
  source: 'live',
});

/**
 * HTTP half of the native team surface. Read-only member diagnostics reuse the
 * exact snapshot that produced the statuses, so both halves of the response
 * describe one run even during a relaunch. Runtime control stays a pure
 * OpenCode bridge service.
 */
export function createNativeTeamHttpApis(
  deps: NativeTeamHttpApisDependencies
): TeamHttpHandlerApis {
  const lifecycle = deps.runtime.lifecycle;
  const surface = createNativeRuntimeSurface(deps.runtime.runtime);
  const snapshots = new Map<string, Readonly<TeamLifecycleSnapshot>>();
  const snapshotKey = (teamName: string, runId: string): string => `${teamName}\0${runId}`;
  const readSnapshot = (teamName: string): Promise<Readonly<TeamLifecycleSnapshot> | null> =>
    lifecycle.queries.snapshot({ expectedContext: lifecycle.owner, teamName });

  return {
    provisioningStart: surface.provisioningStart,
    provisioningStatus: surface.provisioningStatus,
    taskActivity: deps.taskActivity,
    runtime: {
      getRuntimeState: surface.runtime.getRuntimeState,
      stopTeam: surface.runtime.stopTeam,
      getAliveTeams: surface.runtime.getAliveTeams,
    },
    runtimeControl: deps.runtimeControl,
    memberDiagnostics: {
      getMemberSpawnStatusesReadOnly: async (teamName) => {
        const snapshot = await readSnapshot(teamName);
        if (!snapshot) return EMPTY_STATUSES(deps.now());
        for (const key of [...snapshots.keys()]) {
          if (key.startsWith(`${teamName}\0`)) snapshots.delete(key);
        }
        snapshots.set(snapshotKey(teamName, snapshot.identity.runId), snapshot);
        return toMemberSpawnStatuses(snapshot, deps.now());
      },
      getTeamAgentRuntimeSnapshotReadOnly: async (teamName, options) => {
        const runId = options?.memberSpawnStatuses?.runId;
        const cached = runId ? snapshots.get(snapshotKey(teamName, runId)) : undefined;
        const snapshot = cached ?? (await readSnapshot(teamName));
        if (!snapshot) return { teamName, updatedAt: deps.now(), runId: null, members: {} };
        return toTeamAgentRuntimeSnapshot(snapshot, deps.now());
      },
    },
  };
}
