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
  MemberLaunchSettingsPort,
  MemberRuntimePort,
  OwnedMemberLane,
  OwnedMemberLaneGroup,
  OwnedMemberRuntime,
  TeamOperationGate,
} from '../ports/MemberRuntimePorts';

interface Dependencies {
  registry: MemberLifecycleRegistry;
  settings: MemberLaunchSettingsPort;
  runtime: MemberRuntimePort;
  gate: TeamOperationGate;
  nextOperationId(): string;
}

interface PendingRestart {
  target: Readonly<MemberGenerationTarget>;
  abort: AbortController;
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
    signal?: AbortSignal
  ): Promise<MemberStartAdmission> {
    const target = Object.freeze({ ...input });
    let detach = (): void => undefined;
    try {
      const selected = await this.ports.gate.run(target.teamName, async () => {
        signal?.throwIfAborted();
        if (this.laneGroupsFor(target, target.memberName).length > 0)
          throw new MemberRestartConflictError(
            'Restarting a member of a shared adapter lane is not supported yet'
          );
        this.ports.registry.assertRestartTarget(target);
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

  private async completeRestart(
    restart: PendingRestart,
    stops: readonly Promise<void>[]
  ): Promise<MemberStartAdmission> {
    const { target } = restart;
    try {
      await this.awaitStops(stops);
      return await this.ports.gate.run(target.teamName, async () => {
        if (restart.abort.signal.aborted) throw new Error('Member restart was cancelled');
        this.ports.registry.assertRestartTarget(target);
        const member = this.ports.registry.snapshot(target.teamName).members[target.memberName];
        if (member.process || member.lane || member.resources !== 'released')
          throw new Error('Member restart resources were not released');
        const admission = this.ports.registry.beginStart(
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
    execution.completion = this.startLaneGroup(execution);
  }

  async stop(team: TeamRunIdentity, memberName: string): Promise<void> {
    const stops = await this.ports.gate.run(team.teamName, async () => {
      this.ports.registry.requestStop(team, memberName);
      return this.cancelAdmitted(team, [memberName]);
    });
    await this.awaitStops(stops);
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
    execution.completion = this.spawn(execution);
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
        },
        connectionLost: () => {
          if (accepted) this.ports.registry.observeConnectionLost(token);
        },
        failed: (error) => {
          if (accepted) this.ports.registry.observeRuntimeFailed(token, error);
        },
        releaseFailed: (error) => {
          if (!accepted) return;
          this.ports.registry.observeRuntimeFailed(token, error);
          this.ports.registry.observeMemberReleaseFailed(token);
        },
        exited: (exit) => {
          terminated = true;
          if (accepted && 'identity' in runtime)
            this.ports.registry.observeExit(token, runtime.identity, exit);
        },
        laneObserved: (observation) => {
          if (accepted) this.ports.registry.observeLane(token, observation);
        },
        laneLost: (error) => {
          terminated = true;
          if (accepted) this.ports.registry.observeLaneLost(token, error);
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
          if (token && accepted.get(memberName))
            this.ports.registry.observeLane(token, observation);
        },
        lost: (memberName, error) => {
          const token = byName.get(memberName);
          if (token && accepted.get(memberName)) this.ports.registry.observeLaneLost(token, error);
        },
        failed: (memberName, error) => {
          const token = byName.get(memberName);
          if (token && accepted.get(memberName))
            this.ports.registry.observeRuntimeFailed(token, error);
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
