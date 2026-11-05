import { createLogger } from '@shared/utils/logger';

import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamProvisioningLeadActivity');
const transitionVersions = new WeakMap<Set<string>, Map<string, number>>();
let nextTransitionVersion = 0;

type IntervalResult = { failed?: boolean };
type IntervalOperation = IntervalResult | Promise<IntervalResult>;
export type LeadActivityState = 'active' | 'idle' | 'offline';

export interface LeadActivityRunLike {
  teamName: string;
  runId: string;
  leadActivityState: LeadActivityState;
  leadActivityPublished?: boolean;
}

export interface LeadActivityAccessorRunLike extends LeadActivityRunLike {
  processKilled: boolean;
  cancelRequested: boolean;
}

export interface LeadActivityAccessorPorts<TRun extends LeadActivityAccessorRunLike> {
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
  getRuntimeAdapterRun(teamName: string): { runId: string } | null | undefined;
  getRuntimeAdapterProgress(runId: string): { state?: string } | null | undefined;
  syncLeadTaskActivityForState(
    run: TRun,
    state: LeadActivityState,
    previousState: LeadActivityState
  ): void;
}

export interface LeadTaskActivityIntervalPorts<TRun extends LeadActivityRunLike> {
  syncedRunKeys: Set<string>;
  getRunLeadName(run: TRun): string;
  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): IntervalOperation;
  pauseActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): IntervalOperation;
}

export interface SetLeadActivityPorts<
  TRun extends LeadActivityRunLike,
> extends LeadTaskActivityIntervalPorts<TRun> {
  isCurrentTrackedRun(run: TRun): boolean;
  nowIso(): string;
  emitTeamChange(event: TeamChangeEvent): void;
}

export function getLeadTaskActivityRunKey(
  run: Pick<LeadActivityRunLike, 'teamName' | 'runId'>
): string {
  return `${run.teamName}\u0000${run.runId}`;
}

export function getLeadActivityStateForTeam<TRun extends LeadActivityAccessorRunLike>(
  teamName: string,
  ports: LeadActivityAccessorPorts<TRun>
): { state: LeadActivityState; runId: string | null } {
  const runId = ports.getTrackedRunId(teamName);
  if (!runId) return { state: 'offline', runId: null };

  const run = ports.getRun(runId);
  if (!run) {
    const runtimeAdapterRun = ports.getRuntimeAdapterRun(teamName);
    const runtimeProgress = ports.getRuntimeAdapterProgress(runId);
    if (
      runtimeAdapterRun?.runId === runId &&
      !['cancelled', 'disconnected', 'failed'].includes(runtimeProgress?.state ?? '')
    ) {
      return { state: 'idle', runId };
    }
    return { state: 'offline', runId: null };
  }

  if (run.processKilled || run.cancelRequested) return { state: 'offline', runId: null };

  ports.syncLeadTaskActivityForState(run, run.leadActivityState, run.leadActivityState);
  return { state: run.leadActivityState, runId };
}

export function syncLeadTaskActivityForState<TRun extends LeadActivityRunLike>(
  run: TRun,
  state: LeadActivityState,
  previousState: LeadActivityState,
  ports: LeadTaskActivityIntervalPorts<TRun>,
  at: string
): void {
  const key = getLeadTaskActivityRunKey(run);
  const wasSynced = ports.syncedRunKeys.has(key);
  const shouldResume = state === 'active';
  if (shouldResume ? wasSynced : previousState !== 'active' && !wasSynced) return;

  // Record the desired state immediately so repeated renderer reads do not
  // enqueue duplicate operations while the registry request is pending.
  if (shouldResume) ports.syncedRunKeys.add(key);
  else ports.syncedRunKeys.delete(key);

  let versions = transitionVersions.get(ports.syncedRunKeys);
  if (!versions) {
    versions = new Map<string, number>();
    transitionVersions.set(ports.syncedRunKeys, versions);
  }
  const version = ++nextTransitionVersion;
  versions.set(key, version);
  const currentVersions = versions;
  const onFailure = (): void => {
    // An older failure must not undo a newer activity transition.
    if (currentVersions.get(key) !== version) return;
    if (shouldResume) ports.syncedRunKeys.delete(key);
    else ports.syncedRunKeys.add(key);
    logger.warn(`[${run.teamName}] Could not synchronize lead task activity`);
  };
  try {
    const operation = shouldResume
      ? ports.resumeActiveIntervalsForMember(run.teamName, ports.getRunLeadName(run), at)
      : ports.pauseActiveIntervalsForMember(run.teamName, ports.getRunLeadName(run), at);
    void Promise.resolve(operation).then((result) => {
      if (result.failed) onFailure();
      else if (currentVersions.get(key) === version) currentVersions.delete(key);
    }, onFailure);
  } catch {
    onFailure();
  }
}

export function setLeadActivity<TRun extends LeadActivityRunLike>(
  run: TRun,
  state: LeadActivityState,
  ports: SetLeadActivityPorts<TRun>
): void {
  const previousState = run.leadActivityState;
  const isCurrentRun = ports.isCurrentTrackedRun(run);
  if (isCurrentRun) {
    syncLeadTaskActivityForState(run, state, previousState, ports, ports.nowIso());
  } else {
    const key = getLeadTaskActivityRunKey(run);
    ports.syncedRunKeys.delete(key);
    transitionVersions.get(ports.syncedRunKeys)?.delete(key);
  }
  if (previousState === state && run.leadActivityPublished) return;
  run.leadActivityState = state;
  if (!isCurrentRun) return;
  run.leadActivityPublished = true;
  ports.emitTeamChange({
    type: 'lead-activity',
    teamName: run.teamName,
    runId: run.runId,
    detail: state,
  });
}
