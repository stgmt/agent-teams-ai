import { MemberRestartConflictError } from '../../domain/MemberRestartConflictError';
import { MemberSkipConflictError } from '../../domain/MemberSkipConflictError';
import { awaitWithAbort } from '../awaitWithAbort';

import { laneGroupKey, memberKey as key } from './MemberRunKey';

import type {
  MemberProcessToken,
  MemberStartAdmission,
  TeamRunIdentity,
} from '../../../contracts';
import type { MemberLifecycleRegistry } from '../../domain/MemberLifecycleRegistry';
import type {
  MemberLanePermission,
  MemberLaunchSettingsPort,
  MemberRuntimePort,
  OwnedMemberLaneGroup,
  TeamOperationGate,
} from '../ports/MemberRuntimePorts';
import type { RetryFailedOpenCodeSecondaryLanesResult } from '@shared/types';

/** Lane execution owned by `MemberLaneCommands`; the parent never inspects it. */
export interface LaneGroupExecution {
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

/**
 * Lane (adapter group) half of the member lifecycle commands.
 *
 * A lane hosts several members in one runtime process, so its execution, retry
 * plans and permission routing are a separate concern from per-member
 * processes. Everything it needs from the member half is injected: the lane
 * never reaches into the owning class.
 */
export interface MemberLaneCommandPorts {
  registry: MemberLifecycleRegistry;
  settings: MemberLaunchSettingsPort;
  runtime: MemberRuntimePort;
  gate: TeamOperationGate;
  nextOperationId(): string;
  launch(token: Readonly<MemberProcessToken>): void;
  settleTeamLaunch(team: Readonly<TeamRunIdentity>): void;
  cancelAdmitted(
    team: TeamRunIdentity,
    memberNames: readonly string[]
  ): readonly Promise<void>[];
  awaitStops(stops: readonly Promise<void>[]): Promise<void>;
  settled(team: TeamRunIdentity, memberName: string): Promise<void>;
  /** A full team launch is in flight; retrying a lane under it would race it. */
  teamLaunchInProgress(team: Readonly<TeamRunIdentity>): boolean;
}

export class MemberLaneCommands {
  private readonly laneGroups = new Map<string, LaneGroupExecution>();
  private readonly failedLaneGroups = new Map<string, FailedLaneGroup>();
  private readonly laneRetries = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();

  constructor(private readonly ports: MemberLaneCommandPorts) {}

  /** Every lane execution of this process, in creation order. */
  entries(): LaneGroupExecution[] {
    return [...this.laneGroups.values()];
  }

  private launch(token: Readonly<MemberProcessToken>): void {
    this.ports.launch(token);
  }

  private settleTeamLaunch(team: Readonly<TeamRunIdentity>): void {
    this.ports.settleTeamLaunch(team);
  }

  private cancelAdmitted(
    team: TeamRunIdentity,
    memberNames: readonly string[]
  ): readonly Promise<void>[] {
    return this.ports.cancelAdmitted(team, memberNames);
  }

  private awaitStops(stops: readonly Promise<void>[]): Promise<void> {
    return this.ports.awaitStops(stops);
  }

  private settled(team: TeamRunIdentity, memberName: string): Promise<void> {
    return this.ports.settled(team, memberName);
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
    if (this.ports.teamLaunchInProgress(run) || snapshot.state === 'preparing')
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

  /** Stops one lane and releases its members; idempotent per execution. */
  stopLaneGroup(execution: LaneGroupExecution): Promise<void> {
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

  /** Lanes of this run that host the member; the member half stops them. */
  laneGroupsFor(team: TeamRunIdentity, memberName: string): LaneGroupExecution[] {
    return [...this.laneGroups.values()].filter(
      (group) =>
        key(group.tokens[0]!, '') === key(team, '') &&
        group.tokens.some((token) => token.memberName === memberName)
    );
  }
}
