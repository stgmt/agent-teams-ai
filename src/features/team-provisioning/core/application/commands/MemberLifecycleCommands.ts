import { MemberRestartConflictError } from '../../domain/MemberRestartConflictError';
import { MemberSkipConflictError } from '../../domain/MemberSkipConflictError';
import { awaitWithAbort } from '../awaitWithAbort';
import { OwnedRuntimeCleanupError } from '../OwnedRuntimeCleanupError';

import type {
  MemberGenerationTarget,
  MemberProcessToken,
  MemberStartAdmission,
  TeamRunIdentity,
} from '../../../contracts';
import type { MemberLifecycleRegistry } from '../../domain/MemberLifecycleRegistry';
import type {
  ConfiguredMemberLaunch,
  MemberAttachReason,
  MemberLanePermission,
  MemberLaunchSettingsPort,
  MemberRuntimePort,
  OwnedMemberLane,
  OwnedMemberLaneGroup,
  OwnedMemberRuntime,
  TeamOperationGate,
} from '../ports/MemberRuntimePorts';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

interface Dependencies {
  registry: MemberLifecycleRegistry;
  settings: MemberLaunchSettingsPort;
  runtime: MemberRuntimePort;
  gate: TeamOperationGate;
  nextOperationId(): string;
  registerConfiguredMember?(
    team: TeamRunIdentity,
    launch: Readonly<ConfiguredMemberLaunch>
  ): Promise<void>;
}

interface PendingRestart {
  target: Readonly<MemberGenerationTarget>;
  abort: AbortController;
  allowLead: boolean;
  result: Promise<MemberStartAdmission>;
}

interface Execution {
  token: Readonly<MemberProcessToken>;
  abort: AbortController;
  runtime: OwnedMemberRuntime | null;
  unsubscribe: (() => void) | null;
  released: boolean;
  cleanup: (() => Promise<void>) | null;
  completion: Promise<void>;
  stop: Promise<void> | null;
}

interface LaneGroupExecution {
  laneId: string;
  tokens: readonly Readonly<MemberProcessToken>[];
  accepted: Map<string, boolean>;
  abort: AbortController;
  group: OwnedMemberLaneGroup | null;
  unsubscribe: (() => void) | null;
  stop: Promise<void> | null;
  released: boolean;
  completion: Promise<void>;
}

/** A lane whose launch failed; it keeps the plan retryable without a live execution. */
interface FailedLaneGroup {
  run: Readonly<TeamRunIdentity>;
  laneId: string;
  memberNames: readonly string[];
}

function key(team: TeamRunIdentity, memberName: string): string {
  return JSON.stringify([
    team.appInstanceId,
    team.dataRootFingerprint,
    team.connectionGeneration,
    team.teamName,
    team.runId,
    memberName,
  ]);
}

function laneGroupKey(team: TeamRunIdentity, laneId: string): string {
  return `${key(team, '')}|${laneId}`;
}

export class MemberLifecycleCommands {
  private readonly executions = new Map<string, Execution>();
  private readonly laneGroups = new Map<string, LaneGroupExecution>();
  private readonly failedLaneGroups = new Map<string, FailedLaneGroup>();
  private readonly laneRetries = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly teamLaunches = new Set<string>();
  private readonly restarts = new Map<string, PendingRestart>();

  constructor(private readonly ports: Dependencies) {}

  start(team: TeamRunIdentity, memberName: string): Promise<MemberStartAdmission> {
    return this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.assertRun(team);
      if (
        this.restarts.has(key(team, memberName)) ||
        this.executions.get(key(team, memberName))?.stop
      )
        return { kind: 'stopping' as const };
      const admission = this.ports.registry.beginStart(
        team,
        memberName,
        this.ports.nextOperationId()
      );
      if (admission.kind === 'launch') this.launch(admission.token);
      return admission;
    });
  }

  skip(input: Readonly<MemberGenerationTarget>, signal?: AbortSignal): Promise<void> {
    const target = Object.freeze({ ...input });
    return this.ports.gate.run(target.teamName, async () => {
      signal?.throwIfAborted();
      if (this.restarts.has(key(target, target.memberName)))
        throw new MemberSkipConflictError('Member restart is still settling');
      this.ports.registry.skipMemberForLaunch(target);
    });
  }

  async restart(
    input: Readonly<MemberGenerationTarget>,
    signal?: AbortSignal,
    options: { allowLead?: boolean } = {}
  ): Promise<MemberStartAdmission> {
    const target = Object.freeze({ ...input });
    let detach = (): void => undefined;
    try {
      const selected = await this.ports.gate.run(target.teamName, async () => {
        signal?.throwIfAborted();
        const sharedLane = this.laneGroupsFor(target, target.memberName).find(
          (group) => group.tokens.length > 1
        );
        if (sharedLane)
          throw new MemberRestartConflictError(
            'Restarting a member of a shared adapter lane is not supported yet'
          );
        this.ports.registry.assertRestartTarget(target, options.allowLead === true);
        const identity = key(target, target.memberName);
        let restart = this.restarts.get(identity);
        if (restart && restart.target.generation !== target.generation)
          throw new MemberRestartConflictError(
            'Another member generation restart is still settling'
          );
        if (!restart) {
          this.ports.registry.requestStop(target, target.memberName);
          const stops = this.cancelAdmitted(target, [target.memberName]);
          const pending: PendingRestart = {
            target,
            abort: new AbortController(),
            allowLead: options.allowLead === true,
            result: Promise.resolve().then(() => this.completeRestart(pending, stops)),
          };
          this.restarts.set(identity, pending);
          restart = pending;
        }
        const abort = restart.abort;
        const cancel = (): void => abort.abort();
        signal?.addEventListener('abort', cancel, { once: true });
        detach = () => signal?.removeEventListener('abort', cancel);
        return { result: restart.result };
      });
      return await selected.result;
    } finally {
      detach();
    }
  }

  /** Restarts the lead runtime in place; the team run and its other members stay. */
  restartLead(
    team: TeamRunIdentity,
    memberName: string,
    generation: number
  ): Promise<MemberStartAdmission> {
    return this.restart({ ...team, memberName, generation }, undefined, { allowLead: true });
  }

  private async completeRestart(
    restart: PendingRestart,
    stops: readonly Promise<void>[]
  ): Promise<MemberStartAdmission> {
    const { target } = restart;
    try {
      await this.awaitStops(stops);
      return await this.ports.gate.run(target.teamName, async () => {
        if (restart.abort.signal.aborted) throw new Error('Member restart was cancelled');
        this.ports.registry.assertRestartTarget(target, restart.allowLead);
        const member = this.ports.registry.snapshot(target.teamName).members[target.memberName];
        if (member.process || member.lane || member.resources !== 'released')
          throw new Error('Member restart resources were not released');
        const admission =
          member.role === 'lead'
            ? this.ports.registry.beginLeadRestart(
                target,
                target.memberName,
                this.ports.nextOperationId()
              )
            : this.ports.registry.beginStart(
                target,
                target.memberName,
                this.ports.nextOperationId()
              );
        if (admission.kind !== 'launch') throw new Error('Member restart was not admitted');
        this.launch(admission.token);
        return admission;
      });
    } finally {
      await this.ports.gate.run(target.teamName, async () => {
        const identity = key(target, target.memberName);
        if (this.restarts.get(identity) === restart) this.restarts.delete(identity);
      });
    }
  }

  async writeInput(token: MemberProcessToken, line: string): Promise<void> {
    const selected = await this.ports.gate.run(token.teamName, async () => {
      this.ports.registry.assertRun(token);
      const member = this.ports.registry.snapshot(token.teamName).members[token.memberName];
      const group = this.laneGroupsFor(token, token.memberName).find((candidate) =>
        candidate.tokens.some(
          (entry) =>
            entry.generation === token.generation && entry.operationId === token.operationId
        )
      );
      if (group) {
        if (
          member?.desired !== 'running' ||
          !member.lane ||
          member.generation !== token.generation ||
          member.operationId !== token.operationId ||
          !group.group ||
          group.abort.signal.aborted
        )
          throw new Error('Member runtime input is no longer current');
        return { written: group.group.writeInput(token.memberName, line) };
      }
      const execution = this.executions.get(key(token, token.memberName));
      if (
        member?.desired !== 'running' ||
        (!member.process && !member.lane) ||
        member.generation !== token.generation ||
        member.operationId !== token.operationId ||
        !execution?.runtime ||
        execution.abort.signal.aborted
      )
        throw new Error('Member runtime input is no longer current');
      // writeInput validates the owned pipe synchronously; backpressure never holds the operation gate.
      return { written: execution.runtime.writeInput(line) };
    });
    await selected.written;
  }

  // Team commands call this while holding the same application operation gate.
  launchAdmitted(tokens: readonly Readonly<MemberProcessToken>[]): void {
    for (const token of tokens) this.launch(token);
  }

  /** Launches one adapter lane that hosts several members in a single call. */
  launchLane(tokens: readonly Readonly<MemberProcessToken>[], laneId: string): void {
    if (!laneId.trim()) throw new Error('Lane identity is required');
    if (tokens.length === 0) return;
    const first = tokens[0]!;
    const runKey = key(first, '');
    if (tokens.some((token) => key(token, '') !== runKey))
      throw new Error('A lane group must belong to one run');
    const execution: LaneGroupExecution = {
      laneId,
      tokens,
      accepted: new Map(),
      abort: new AbortController(),
      group: null,
      unsubscribe: null,
      stop: null,
      released: false,
      completion: Promise.resolve(),
    };
    this.laneGroups.set(laneGroupKey(first, laneId), execution);
    this.failedLaneGroups.delete(laneGroupKey(first, laneId));
    for (const [failedKey, descriptor] of this.failedLaneGroups.entries()) {
      // Only descriptors from older runs are stale; same-run lanes stay retryable.
      if (descriptor.run.teamName === first.teamName && descriptor.run.runId !== first.runId)
        this.failedLaneGroups.delete(failedKey);
    }
    execution.completion = this.startLaneGroup(execution).finally(() =>
      this.settleTeamLaunch(first)
    );
  }

  async listLanePermissions(input: {
    run: TeamRunIdentity;
  }): Promise<readonly MemberLanePermission[]> {
    const groups = this.laneGroupsForRun(input.run);
    const results = await Promise.all(
      groups.map(async (group) => (await group.group?.listPermissions?.()) ?? [])
    );
    return results.flat();
  }

  async answerLanePermission(input: {
    run: TeamRunIdentity;
    requestId: string;
    allow: boolean;
    message?: string;
  }): Promise<void> {
    for (const group of this.laneGroupsForRun(input.run)) {
      const permissions = (await group.group?.listPermissions?.()) ?? [];
      const permission = permissions.find((entry) => entry.requestId === input.requestId);
      if (!permission) continue;
      await group.group?.answerPermission?.({
        memberName: permission.memberName,
        requestId: input.requestId,
        allow: input.allow,
        ...(input.message ? { message: input.message } : {}),
      });
      return;
    }
    throw new Error('Unknown permission request');
  }

  /**
   * Restarts every member of one adapter lane. A lane that contains the lead
   * requires a team relaunch instead; there is no per-member adapter restart.
   */
  async restartLane(input: {
    run: TeamRunIdentity;
    laneId: string;
  }): Promise<readonly MemberStartAdmission[]> {
    const run = input.run;
    const group = this.laneGroups.get(laneGroupKey(run, input.laneId));
    if (!group) throw new Error('Unknown lane');
    const memberNames = group.tokens.map((token) => token.memberName);
    const snapshot = this.ports.registry.snapshot(run.teamName);
    if (memberNames.some((name) => snapshot.members[name]?.role === 'lead'))
      throw new Error('Restarting the lead lane requires a team relaunch');
    const stops = await this.ports.gate.run(run.teamName, async () => {
      for (const name of memberNames) this.ports.registry.requestStop(run, name);
      return this.cancelAdmitted(run, memberNames);
    });
    await this.awaitStops(stops);
    return this.ports.gate.run(run.teamName, async () => {
      for (const name of memberNames) {
        const member = this.ports.registry.snapshot(run.teamName).members[name];
        if (member.process || member.lane || member.resources !== 'released')
          throw new Error('Lane restart resources were not released');
      }
      const admissions: MemberStartAdmission[] = [];
      try {
        for (const name of memberNames) {
          admissions.push(this.ports.registry.beginStart(run, name, this.ports.nextOperationId()));
        }
        const tokens = admissions.flatMap((admission) =>
          admission.kind === 'launch' ? [admission.token] : []
        );
        if (tokens.length !== memberNames.length) throw new Error('Lane restart was not admitted');
        this.launchLane(tokens, input.laneId);
        return admissions;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const admission of admissions) {
          if (admission.kind !== 'launch') continue;
          this.ports.registry.observeStartFailed(admission.token, message);
          this.ports.registry.observeMemberReleased(admission.token);
        }
        throw error;
      }
    });
  }

  /** Marks a full team launch; retry is refused until every admitted member settles. */
  beginTeamLaunch(run: TeamRunIdentity): void {
    this.teamLaunches.add(key(run, ''));
  }

  abortTeamLaunch(run: TeamRunIdentity): void {
    this.teamLaunches.delete(key(run, ''));
  }

  async retryFailedLanes(run: TeamRunIdentity): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    const retryKey = key(run, '');
    const existing = this.laneRetries.get(retryKey);
    if (existing) return existing;
    const retry = this.retryFailedLanesNow(run).finally(() => {
      if (this.laneRetries.get(retryKey) === retry) this.laneRetries.delete(retryKey);
    });
    this.laneRetries.set(retryKey, retry);
    return retry;
  }

  private async retryFailedLanesNow(
    run: TeamRunIdentity
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    const snapshot = this.ports.registry.snapshot(run.teamName);
    if (this.teamLaunches.has(key(run, '')) || snapshot.state === 'preparing')
      throw new Error('Team launch is still in progress');
    const candidates = new Map<
      string,
      { laneId: string; memberNames: readonly string[]; failedNames: readonly string[] }
    >();
    const skipped: { memberName: string; reason: string }[] = [];
    const leadSkipped = (names: readonly string[]): void => {
      for (const name of names)
        skipped.push({ memberName: name, reason: 'Lead lane requires a team relaunch' });
    };
    for (const group of this.laneGroups.values()) {
      if (key(group.tokens[0]!, '') !== key(run, '')) continue;
      const names = group.tokens.map((token) => token.memberName);
      const failedNames = names.filter((name) => snapshot.members[name]?.phase === 'failed');
      if (failedNames.length === 0) continue;
      if (names.some((name) => snapshot.members[name]?.role === 'lead')) {
        leadSkipped(failedNames);
        continue;
      }
      candidates.set(group.laneId, { laneId: group.laneId, memberNames: names, failedNames });
    }
    for (const descriptor of this.failedLaneGroups.values()) {
      if (key(descriptor.run, '') !== key(run, '') || candidates.has(descriptor.laneId)) continue;
      const failedNames = descriptor.memberNames.filter(
        (name) => snapshot.members[name]?.phase === 'failed'
      );
      if (failedNames.length === 0) continue;
      if (descriptor.memberNames.some((name) => snapshot.members[name]?.role === 'lead')) {
        leadSkipped(failedNames);
        continue;
      }
      candidates.set(descriptor.laneId, {
        laneId: descriptor.laneId,
        memberNames: descriptor.memberNames,
        failedNames,
      });
    }

    const attempted: string[] = [];
    const confirmed: string[] = [];
    const pending: string[] = [];
    const failed: { memberName: string; error: string }[] = [];
    for (const candidate of candidates.values()) {
      if (!this.ports.registry.isLive(run)) {
        for (const name of candidate.failedNames)
          skipped.push({ memberName: name, reason: 'Team stopped during retry' });
        continue;
      }
      try {
        if (this.laneGroups.has(laneGroupKey(run, candidate.laneId)))
          await this.restartLane({ run, laneId: candidate.laneId });
        else await this.relaunchLane(run, candidate.laneId, candidate.memberNames);
        attempted.push(...candidate.failedNames);
        this.failedLaneGroups.delete(laneGroupKey(run, candidate.laneId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          error instanceof MemberRestartConflictError ||
          error instanceof MemberSkipConflictError
        ) {
          for (const name of candidate.failedNames)
            skipped.push({ memberName: name, reason: message });
        } else {
          for (const name of candidate.failedNames)
            failed.push({ memberName: name, error: message });
        }
      }
    }
    await Promise.all(
      attempted
        .filter((name) => !failed.some((entry) => entry.memberName === name))
        .map((name) => this.settled(run, name))
    );
    const after = this.ports.registry.snapshot(run.teamName);
    for (const name of attempted) {
      if (failed.some((entry) => entry.memberName === name)) continue;
      if (!this.ports.registry.isLive(run)) {
        skipped.push({ memberName: name, reason: 'Team stopped during retry' });
        continue;
      }
      const member = after.members[name];
      if (member?.phase === 'ready') confirmed.push(name);
      else if (member?.phase === 'failed')
        failed.push({ memberName: name, error: member.error ?? 'Lane member failed' });
      else if (member?.skippedForLaunch)
        skipped.push({ memberName: name, reason: 'Teammate is skipped for this launch' });
      else pending.push(name);
    }
    return { attempted, confirmed, pending, failed, skipped };
  }

  /** Relaunches a lane whose original launch failed; no live execution owns it. */
  private async relaunchLane(
    run: TeamRunIdentity,
    laneId: string,
    memberNames: readonly string[]
  ): Promise<readonly MemberStartAdmission[]> {
    return this.ports.gate.run(run.teamName, async () => {
      for (const name of memberNames) {
        const member = this.ports.registry.snapshot(run.teamName).members[name];
        if (!member || member.membership !== 'configured')
          throw new Error('Lane member is not configured');
        if (member.process || member.lane || member.resources !== 'released')
          throw new Error('Lane retry resources were not released');
      }
      const admissions: MemberStartAdmission[] = [];
      try {
        for (const name of memberNames)
          admissions.push(this.ports.registry.beginStart(run, name, this.ports.nextOperationId()));
        const tokens = admissions.flatMap((admission) =>
          admission.kind === 'launch' ? [admission.token] : []
        );
        if (tokens.length !== memberNames.length) throw new Error('Lane retry was not admitted');
        this.launchLane(tokens, laneId);
        return admissions;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const admission of admissions) {
          if (admission.kind !== 'launch') continue;
          this.ports.registry.observeStartFailed(admission.token, message);
          this.ports.registry.observeMemberReleased(admission.token);
        }
        throw error;
      }
    });
  }

  async stop(team: TeamRunIdentity, memberName: string): Promise<void> {
    const stops = await this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.requestStop(team, memberName);
      return this.cancelAdmitted(team, [memberName]);
    });
    await this.awaitStops(stops);
  }

  /** Stops and removes a configured teammate; the lead and shared lanes are not detachable. */
  async detach(team: TeamRunIdentity, memberName: string): Promise<void> {
    const stops = await this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.assertRun(team);
      const member = this.ports.registry.snapshot(team.teamName).members[memberName];
      if (!member || member.membership !== 'configured') throw new Error('Unknown member');
      if (member.role === 'lead') throw new Error('Cannot detach the team lead');
      if (this.laneGroupsFor(team, memberName).some((group) => group.tokens.length > 1))
        throw new Error('Detaching a member from a shared adapter lane is not supported');
      this.ports.registry.requestStop(team, memberName);
      return this.cancelAdmitted(team, [memberName]);
    });
    await this.awaitStops(stops);
    await this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.assertRun(team);
      this.ports.registry.removeMember(team, memberName);
    });
  }

  /** Attaches one already-configured teammate and starts its owned runtime. */
  async attach(
    team: TeamRunIdentity,
    memberName: string,
    reason: MemberAttachReason = 'member_added'
  ): Promise<void> {
    const admit = this.ports.settings.admitConfiguredMember;
    if (!admit || !this.ports.registerConfiguredMember)
      throw new Error('Configured member attach is not configured');
    const current = this.ports.registry.snapshot(team.teamName).members[memberName];
    if (current?.membership === 'removed' && reason !== 'member_restored')
      throw new Error('Member was removed');
    await admit.call(this.ports.settings, team, memberName);
    const launch = await this.ports.settings.findConfiguredMember(team, memberName);
    if (!launch || launch.memberName !== memberName || key(launch.team, '') !== key(team, ''))
      throw new Error('Configured member settings changed before attach');
    if (launch.role === 'lead')
      throw new Error('Lead attach is not supported from member controls');
    await this.ports.registerConfiguredMember(team, launch);
    const replaceRuntime = await this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.assertRun(team);
      let member = this.ports.registry.snapshot(team.teamName).members[memberName];
      if (member?.membership === 'removed') {
        if (reason !== 'member_restored') throw new Error('Member was removed');
        this.ports.registry.restoreMember(team, { memberName, role: 'member' });
      } else if (!member) {
        this.ports.registry.addMember(team, { memberName, role: 'member' });
      }
      member = this.ports.registry.snapshot(team.teamName).members[memberName]!;
      if (
        this.restarts.has(key(team, memberName)) ||
        this.executions.get(key(team, memberName))?.stop
      )
        throw new MemberRestartConflictError('Member restart is still settling');
      if (member.process || member.lane) {
        // Only an explicit member update replaces a live runtime; a plain attach is a no-op.
        return reason === 'member_updated' ? member.generation : null;
      }
      const admission = this.ports.registry.beginStart(
        team,
        memberName,
        this.ports.nextOperationId()
      );
      if (admission.kind !== 'launch') throw new Error('Member attach was not admitted');
      this.launch(admission.token);
      return null;
    });
    if (replaceRuntime !== null)
      await this.restart({ ...team, memberName, generation: replaceRuntime });
  }

  cancelAdmitted(team: TeamRunIdentity, memberNames: readonly string[]): readonly Promise<void>[] {
    const stops: Promise<void>[] = [];
    for (const name of memberNames) {
      const restart = this.restarts.get(key(team, name));
      if (restart) {
        restart.abort.abort();
        // Cancellation revokes replacement, but its handle-bound termination still physically drains.
        stops.push(
          restart.result.then(
            () => undefined,
            () => undefined
          )
        );
      }
      const execution = this.executions.get(key(team, name));
      if (execution) {
        execution.abort.abort();
        stops.push(
          execution.stop || execution.runtime || execution.cleanup
            ? this.stopOwnedRuntime(execution)
            : execution.completion.then(async () => {
                if (execution.cleanup) await this.stopOwnedRuntime(execution);
              })
        );
      }
      for (const group of this.laneGroupsFor(team, name)) {
        group.abort.abort();
        stops.push(this.stopLaneGroup(group));
      }
    }
    return stops;
  }

  hasUnreleased(team: TeamRunIdentity): boolean {
    return (
      [...this.executions.values()].some(
        (execution) =>
          (!execution.released || execution.stop !== null) &&
          key(execution.token, '') === key(team, '')
      ) ||
      [...this.laneGroups.values()].some(
        (group) =>
          (!group.released || group.stop !== null) &&
          group.tokens.length > 0 &&
          key(group.tokens[0]!, '') === key(team, '')
      )
    );
  }

  async awaitStops(stops: readonly Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(stops);
    const failures: unknown[] = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : []
    );
    if (failures.length) throw new AggregateError(failures, 'Owned member termination failed');
  }

  async settled(team: TeamRunIdentity, memberName: string): Promise<void> {
    const group = this.laneGroupsFor(team, memberName)[0];
    if (group) {
      await group.completion;
      return;
    }
    await this.executions.get(key(team, memberName))?.completion;
  }

  private launch(token: Readonly<MemberProcessToken>): void {
    const execution: Execution = {
      token,
      abort: new AbortController(),
      runtime: null,
      unsubscribe: null,
      released: false,
      cleanup: null,
      completion: Promise.resolve(),
      stop: null,
    };
    this.executions.set(key(token, token.memberName), execution);
    execution.completion = this.spawn(execution).finally(() => this.settleTeamLaunch(token));
  }

  private settleTeamLaunch(team: Readonly<TeamRunIdentity>): void {
    const launchKey = key(team, '');
    if (!this.teamLaunches.has(launchKey)) return;
    const snapshot = this.ports.registry.snapshot(team.teamName);
    const pending = Object.values(snapshot.members).some(
      (member) =>
        member.membership === 'configured' &&
        (member.phase === 'starting' || member.phase === 'connecting')
    );
    if (!pending) this.teamLaunches.delete(launchKey);
  }

  private startLane(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberLane> {
    const startLane = this.ports.runtime.startLane;
    if (!startLane) throw new Error('Adapter lane runtime is not wired for this provider');
    return startLane.call(this.ports.runtime, settings, token, signal);
  }

  private async spawn(execution: Execution): Promise<void> {
    const { token } = execution;
    try {
      const settings = await awaitWithAbort(
        this.ports.settings.findConfiguredMember(token, token.memberName),
        execution.abort.signal
      );
      execution.abort.signal.throwIfAborted();
      this.ports.registry.assertStartsOpen();
      if (
        settings?.memberName !== token.memberName ||
        !settings.configurationRevision.trim() ||
        key(settings.team, settings.memberName) !== key(token, token.memberName)
      ) {
        throw new Error('Configured launch settings are missing or stale');
      }
      const launchSettings = Object.freeze({
        ...settings,
        team: Object.freeze({ ...settings.team }),
      });
      const kind = this.ports.runtime.kind?.(settings.providerId) ?? 'process';
      const runtime =
        kind === 'lane'
          ? await this.startLane(launchSettings, token, execution.abort.signal)
          : await this.ports.runtime.spawn(launchSettings, token, execution.abort.signal);
      execution.runtime = runtime;
      const accepted =
        'identity' in runtime
          ? this.ports.registry.observeSpawn(token, runtime.identity)
          : this.ports.registry.observeLane(token, runtime.lane);
      let terminated = false;
      const unsubscribe = runtime.subscribe({
        connected: () => {
          if (accepted) this.ports.registry.observeConnected(token);
          this.settleTeamLaunch(token);
        },
        connectionLost: () => {
          if (accepted) this.ports.registry.observeConnectionLost(token);
          this.settleTeamLaunch(token);
        },
        failed: (error) => {
          if (accepted) this.ports.registry.observeRuntimeFailed(token, error);
          this.settleTeamLaunch(token);
        },
        releaseFailed: (error) => {
          if (!accepted) {
            this.settleTeamLaunch(token);
            return;
          }
          this.ports.registry.observeRuntimeFailed(token, error);
          this.ports.registry.observeMemberReleaseFailed(token);
          this.settleTeamLaunch(token);
        },
        exited: (exit) => {
          terminated = true;
          if (accepted && 'identity' in runtime)
            this.ports.registry.observeExit(token, runtime.identity, exit);
          this.settleTeamLaunch(token);
        },
        laneObserved: (observation) => {
          if (accepted) this.ports.registry.observeLane(token, observation);
          this.settleTeamLaunch(token);
        },
        laneLost: (error) => {
          terminated = true;
          if (accepted) this.ports.registry.observeLaneLost(token, error);
          this.settleTeamLaunch(token);
        },
        released: () => {
          // A lane release is authoritative: clear any lane that never reported a loss.
          if ('lane' in runtime) {
            if (accepted) this.ports.registry.observeLaneLost(token);
          } else if (!terminated) return;
          // Release belongs to this subscribed handle even when its generation is no longer current.
          if (accepted) this.ports.registry.observeMemberReleased(token);
          execution.runtime = null;
          execution.released = true;
          execution.unsubscribe?.();
          execution.unsubscribe = null;
          this.settleTeamLaunch(token);
        },
      });
      // Resource release may have been replayed synchronously by subscribe().
      if (execution.released) unsubscribe();
      else execution.unsubscribe = unsubscribe;
      if (!accepted || execution.abort.signal.aborted) await this.stopOwnedRuntime(execution);
    } catch (error) {
      if (error instanceof OwnedRuntimeCleanupError) execution.cleanup = error.release;
      else if (!execution.runtime) execution.released = true;
      this.ports.registry.observeStartFailed(
        token,
        error instanceof Error ? error.message : String(error)
      );
      if (execution.cleanup) this.ports.registry.observeMemberReleaseFailed(token);
      else if (execution.released) this.ports.registry.observeMemberReleased(token);
    }
  }

  private async startLaneGroup(execution: LaneGroupExecution): Promise<void> {
    const { tokens, abort } = execution;
    const accepted = execution.accepted;
    const byName = new Map(tokens.map((token) => [token.memberName, token]));
    try {
      const settings = await Promise.all(
        tokens.map(async (token) => {
          const settings = await awaitWithAbort(
            this.ports.settings.findConfiguredMember(token, token.memberName),
            abort.signal
          );
          abort.signal.throwIfAborted();
          if (
            settings?.memberName !== token.memberName ||
            !settings.configurationRevision.trim() ||
            key(settings.team, settings.memberName) !== key(token, token.memberName)
          ) {
            throw new Error('Configured launch settings are missing or stale');
          }
          return Object.freeze({ ...settings, team: Object.freeze({ ...settings.team }) });
        })
      );
      this.ports.registry.assertStartsOpen();
      const startLaneGroup = this.ports.runtime.startLaneGroup;
      if (!startLaneGroup)
        throw new Error('Adapter lane group runtime is not wired for this provider');
      const group = await startLaneGroup.call(
        this.ports.runtime,
        settings,
        tokens,
        execution.laneId,
        abort.signal
      );
      execution.group = group;
      for (const token of tokens) {
        if (!group.observations[token.memberName])
          throw new Error('Adapter lane evidence is missing for a member');
      }
      for (const token of tokens) {
        accepted.set(
          token.memberName,
          this.ports.registry.observeLane(token, group.observations[token.memberName]!)
        );
      }
      const unsubscribe = group.subscribe({
        observed: (memberName, observation) => {
          const token = byName.get(memberName);
          if (token && accepted.get(memberName)) {
            this.ports.registry.observeLane(token, observation);
            this.settleTeamLaunch(token);
          }
        },
        lost: (memberName, error) => {
          const token = byName.get(memberName);
          if (token && accepted.get(memberName)) {
            this.ports.registry.observeLaneLost(token, error);
            this.settleTeamLaunch(token);
          }
        },
        failed: (memberName, error) => {
          const token = byName.get(memberName);
          if (token && accepted.get(memberName)) {
            this.ports.registry.observeRuntimeFailed(token, error);
            this.settleTeamLaunch(token);
          }
        },
        released: () => this.releaseLaneGroup(execution),
      });
      execution.unsubscribe = unsubscribe;
      if (execution.released) unsubscribe();
      if (abort.signal.aborted) await this.stopLaneGroup(execution);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (execution.group) {
        try {
          await execution.group.stop();
        } catch {
          // The lane may still run: keep the release debt visible instead of hiding it.
          for (const token of tokens) {
            if (accepted.get(token.memberName))
              this.ports.registry.observeMemberReleaseFailed(token);
          }
          return;
        }
      }
      for (const token of tokens) {
        if (accepted.get(token.memberName)) {
          this.ports.registry.observeLaneLost(token);
          this.ports.registry.observeMemberReleased(token);
        } else {
          this.ports.registry.observeStartFailed(token, message);
          if (!this.ports.registry.snapshot(token.teamName).members[token.memberName]?.lane)
            this.ports.registry.observeMemberReleased(token);
        }
      }
      execution.released = true;
      execution.group = null;
      execution.unsubscribe?.();
      execution.unsubscribe = null;
      this.forgetLaneGroup(execution);
      // Keep the lane plan retryable even though no execution owns it anymore.
      this.failedLaneGroups.set(laneGroupKey(tokens[0]!, execution.laneId), {
        run: Object.freeze({
          appInstanceId: tokens[0]!.appInstanceId,
          dataRootFingerprint: tokens[0]!.dataRootFingerprint,
          connectionGeneration: tokens[0]!.connectionGeneration,
          teamName: tokens[0]!.teamName,
          runId: tokens[0]!.runId,
        }),
        laneId: execution.laneId,
        memberNames: tokens.map((token) => token.memberName),
      });
    }
  }

  private releaseLaneGroup(execution: LaneGroupExecution): void {
    if (execution.released) return;
    for (const token of execution.tokens) {
      if (!execution.accepted.get(token.memberName)) continue;
      this.ports.registry.observeLaneLost(token);
      this.ports.registry.observeMemberReleased(token);
    }
    execution.group = null;
    execution.released = true;
    execution.unsubscribe?.();
    execution.unsubscribe = null;
    this.forgetLaneGroup(execution);
    if (execution.tokens[0]) this.settleTeamLaunch(execution.tokens[0]);
  }

  private forgetLaneGroup(execution: LaneGroupExecution): void {
    if (execution.tokens.length === 0) return;
    this.laneGroups.delete(laneGroupKey(execution.tokens[0]!, execution.laneId));
  }

  private stopLaneGroup(execution: LaneGroupExecution): Promise<void> {
    if (execution.stop) return execution.stop;
    if (execution.released) return Promise.resolve();
    if (!execution.group) return Promise.resolve();
    execution.stop = Promise.resolve()
      .then(() => execution.group?.stop())
      .then(() => {
        // A resolved lane stop is authoritative even if the adapter emitted no release event.
        if (!execution.released) this.releaseLaneGroup(execution);
      })
      .finally(() => {
        execution.stop = null;
      });
    return execution.stop;
  }

  private laneGroupsForRun(team: TeamRunIdentity): LaneGroupExecution[] {
    return [...this.laneGroups.values()].filter(
      (group) => key(group.tokens[0]!, '') === key(team, '')
    );
  }

  private laneGroupsFor(team: TeamRunIdentity, memberName: string): LaneGroupExecution[] {
    return [...this.laneGroups.values()].filter(
      (group) =>
        key(group.tokens[0]!, '') === key(team, '') &&
        group.tokens.some((token) => token.memberName === memberName)
    );
  }

  private stopOwnedRuntime(execution: Execution): Promise<void> {
    if (execution.stop) return execution.stop;
    if (execution.released) return Promise.resolve();
    if (!execution.runtime && !execution.cleanup) return Promise.resolve();
    execution.stop = Promise.resolve()
      .then(async () => {
        if (execution.runtime) {
          try {
            await execution.runtime.stop();
          } catch (error) {
            // A prior runtime failure stays in the snapshot, but exact release ends ownership.
            if (!execution.released) throw error;
          }
        }
        if (execution.cleanup) {
          await execution.cleanup();
          execution.cleanup = null;
          execution.released = true;
          this.ports.registry.observeMemberReleased(execution.token);
        }
      })
      .finally(() => {
        execution.stop = null;
      });
    return execution.stop;
  }
}
