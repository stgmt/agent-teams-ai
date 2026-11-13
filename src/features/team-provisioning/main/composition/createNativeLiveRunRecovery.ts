import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';
import {
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
} from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import { NativeOpenCodeLaneRuntime } from '../adapters/output/NativeOpenCodeLaneRuntime';
import {
  projectRecoveredMembers,
  recoveredWorkspace,
} from '../adapters/output/NativeRecoveredMemberProjection';

import type { MemberProcessToken } from '../../contracts';
import type { MemberLifecycleCommands } from '../../core/application/commands/MemberLifecycleCommands';
import type { OwnedMemberLaneGroup } from '../../core/application/ports/MemberRuntimePorts';
import type { MemberLifecycleRegistry } from '../../core/domain/MemberLifecycleRegistry';
import type { NativeOpenCodePromptDeliverySupervisor } from '../adapters/output/NativeOpenCodePromptDeliverySupervisor';
import type { NodeMemberRuntime } from '../adapters/output/NodeMemberRuntime';
import type { NativeRunRecovery } from '../adapters/output/NodeNativeTeamConfig';
import type { NodeTeamLaunchSettings } from '../adapters/output/NodeTeamLaunchSettings';
import type { OpenCodeLaneAdapter } from './selectOpenCodeLaneAdapter';

export interface NativeLiveRunRecoveryDependencies {
  teamsRoot: string;
  /** Enables relay polling for a run that recovered with live runtime work. */
  relayIntervalMs?: number;
  openCodeAdapter?: OpenCodeLaneAdapter;
  settings: Pick<NodeTeamLaunchSettings, 'restore' | 'capture' | 'findConfiguredMember'>;
  registry: Pick<MemberLifecycleRegistry, 'adoptTeam'>;
  commands: Pick<MemberLifecycleCommands, 'adoptProcess' | 'lanes'>;
  runtime: Pick<NodeMemberRuntime, 'reconnect'>;
  /** Provider captured per run, so a recovered run answers "was this an OpenCode run". */
  configuredProvidersByRun: Map<string, ReadonlyMap<string, string>>;
  retainLane(
    group: OwnedMemberLaneGroup,
    tokens: readonly Readonly<MemberProcessToken>[],
    laneId: string
  ): OwnedMemberLaneGroup;
  startRelays(teamName: string, intervalMs: number): void;
  promptDelivery: Pick<NativeOpenCodePromptDeliverySupervisor, 'start'> | null;
}

/**
 * Re-admits a surviving run: observes its OpenCode lanes, restores canonical
 * settings, adopts the team, then adopts each lane group and process. Answers
 * `true` only when runtime work survived and is now owned again.
 */
export function createNativeLiveRunRecovery(
  deps: NativeLiveRunRecoveryDependencies
): (recovery: NativeRunRecovery) => Promise<boolean> {
  const { teamsRoot, openCodeAdapter, relayIntervalMs } = deps;
  return async (recovery) => {
    const { run } = recovery;
    const members = projectRecoveredMembers(recovery);
    const laneGroups: { laneId: string; group: OwnedMemberLaneGroup; names: string[] }[] = [];
    const codeRows = recovery.members.filter(
      (row) => (row.providerId ?? row.provider) === 'opencode'
    );
    if (
      !openCodeAdapter &&
      codeRows.some((row) => row.runtimeOperationId != null || row.runtimeSessionId != null)
    )
      throw new Error('Persisted lane attempt cannot be recovered without its runtime adapter');
    if (codeRows.length && openCodeAdapter) {
      const index = await readOpenCodeRuntimeLaneIndex(teamsRoot, run.teamName);
      const manifest = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath: teamsRoot });
      const byLane = new Map<string, typeof codeRows>();
      for (const row of codeRows) {
        const laneId =
          typeof row.runtimeLaneId === 'string'
            ? row.runtimeLaneId
            : codeRows.length === recovery.members.length
              ? 'primary'
              : buildOpenCodeSecondaryLaneId({ name: String(row.name) });
        const group = byLane.get(laneId) ?? [];
        group.push(row);
        byLane.set(laneId, group);
      }
      const laneRuntime = new NativeOpenCodeLaneRuntime({ adapter: openCodeAdapter });
      for (const [laneId, rows] of byLane) {
        if (
          index.lanes[laneId]?.state !== 'active' ||
          (await manifest.read(run.teamName, laneId)).activeRunId !== run.runId
        ) {
          if (rows.some((row) => row.runtimeOperationId != null || row.runtimeSessionId != null))
            throw new Error(
              'Persisted lane attempt has no matching live manifest; acceptance remains unresolved'
            );
          continue;
        }
        if (
          rows.some(
            (row) =>
              !Number.isSafeInteger(row.runtimeGeneration) ||
              Number(row.runtimeGeneration) < 1 ||
              typeof row.runtimeOperationId !== 'string'
          )
        )
          throw new Error('Surviving lane has no durable attempt identity');
        const cwd = rows[0]?.cwd;
        if (typeof cwd !== 'string') throw new Error('Surviving lane has no persisted workspace');
        const group = await laneRuntime.observeExisting({
          runId: run.runId,
          teamName: run.teamName,
          laneId,
          cwd,
          providerId: 'opencode',
          skipPermissions: false,
          previousLaunchState: null,
          expectedMembers: rows.map((row) => ({
            name: String(row.name),
            cwd: String(row.cwd),
            providerId: 'opencode',
          })),
        });
        for (const member of members) {
          const observation = group.observations[member.memberName];
          if (observation) member.lane = observation;
        }
        laneGroups.push({ laneId, group, names: rows.map((row) => String(row.name)) });
      }
    }
    if (!members.some((member) => member.process || member.lane?.runtimeAlive)) return false;
    await deps.settings.restore(run, recoveredWorkspace(recovery));
    const canonical = await deps.settings.capture(run);
    if (canonical.configurationRevision !== recovery.configurationRevision)
      throw new Error('Canonical team settings changed since the surviving run was admitted');
    const configured = new Set(canonical.members.map((member) => member.memberName));
    if (
      members.some(
        (member) => (member.process || member.lane) && !configured.has(member.memberName)
      )
    )
      throw new Error('Surviving runtime member is no longer canonically configured');
    deps.registry.adoptTeam(
      run,
      canonical.members.map((identity) => ({
        ...(members.find((member) => member.memberName === identity.memberName) ?? {
          generation: 0,
          operationId: null,
          process: null,
          lane: null,
        }),
        ...identity,
      }))
    );
    deps.configuredProvidersByRun.set(
      run.runId,
      new Map(
        recovery.members.map((row) => [String(row.name), String(row.providerId ?? row.provider)])
      )
    );
    for (const lane of laneGroups) {
      const tokens = lane.names.map((name) => {
        const member = members.find((entry) => entry.memberName === name)!;
        return {
          ...run,
          memberName: name,
          generation: member.generation,
          operationId: member.operationId!,
        };
      });
      deps.commands.lanes.adoptLane(
        tokens,
        lane.laneId,
        deps.retainLane(lane.group, tokens, lane.laneId)
      );
    }
    for (const member of members) {
      if (!member.process) continue;
      const process = member.process;
      const row = recovery.members.find((entry) => entry.name === member.memberName)!;
      const token = {
        ...run,
        memberName: member.memberName,
        generation: member.generation,
        operationId: member.operationId!,
      };
      const launchSettings = await deps.settings.findConfiguredMember(run, member.memberName);
      if (!launchSettings) throw new Error('Surviving native member configuration is unavailable');
      const abort = new AbortController();
      const handle = await deps.runtime.reconnect(
        launchSettings,
        token,
        process,
        Number(row.recoveryProcessStartedAt),
        abort.signal
      );
      await deps.commands.adoptProcess(token, handle, launchSettings, abort);
    }
    if (relayIntervalMs && (laneGroups.length || members.some((member) => member.process)))
      deps.startRelays(run.teamName, relayIntervalMs);
    deps.promptDelivery?.start();
    return true;
  };
}
