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
  MemberLaunchSettingsPort,
  MemberRuntimePort,
  OwnedMemberProcess,
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
  process: OwnedMemberProcess | null;
  unsubscribe: (() => void) | null;
  released: boolean;
  cleanup: (() => Promise<void>) | null;
  completion: Promise<void>;
  stop: Promise<void> | null;
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

export class MemberLifecycleCommands {
  private readonly executions = new Map<string, Execution>();
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
        if (member.process || member.resources !== 'released')
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
      const execution = this.executions.get(key(token, token.memberName));
      if (
        member?.desired !== 'running' ||
        !member.process ||
        member.generation !== token.generation ||
        member.operationId !== token.operationId ||
        !execution?.process ||
        execution.abort.signal.aborted
      )
        throw new Error('Member process input is no longer current');
      // writeInput validates the owned pipe synchronously; backpressure never holds the operation gate.
      return { written: execution.process.writeInput(line) };
    });
    await selected.written;
  }

  // Team commands call this while holding the same application operation gate.
  launchAdmitted(tokens: readonly Readonly<MemberProcessToken>[]): void {
    for (const token of tokens) this.launch(token);
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
      if (!execution) continue;
      execution.abort.abort();
      stops.push(
        execution.stop || execution.process || execution.cleanup
          ? this.stopOwnedProcess(execution)
          : execution.completion.then(async () => {
              if (execution.cleanup) await this.stopOwnedProcess(execution);
            })
      );
    }
    return stops;
  }

  hasUnreleased(team: TeamRunIdentity): boolean {
    return [...this.executions.values()].some(
      (execution) =>
        (!execution.released || execution.stop !== null) &&
        key(execution.token, '') === key(team, '')
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
    await this.executions.get(key(team, memberName))?.completion;
  }

  private launch(token: Readonly<MemberProcessToken>): void {
    const execution: Execution = {
      token,
      abort: new AbortController(),
      process: null,
      unsubscribe: null,
      released: false,
      cleanup: null,
      completion: Promise.resolve(),
      stop: null,
    };
    this.executions.set(key(token, token.memberName), execution);
    execution.completion = this.spawn(execution);
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
      const process = await this.ports.runtime.spawn(
        Object.freeze({
          ...settings,
          team: Object.freeze({ ...settings.team }),
        }),
        token,
        execution.abort.signal
      );
      execution.process = process;
      const accepted = this.ports.registry.observeSpawn(token, process.identity);
      let exited = false;
      const unsubscribe = process.subscribe({
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
          exited = true;
          if (accepted) this.ports.registry.observeExit(token, process.identity, exit);
        },
        released: () => {
          if (!exited) return;
          // Release belongs to this subscribed handle even when its generation is no longer current.
          if (accepted) this.ports.registry.observeMemberReleased(token);
          execution.process = null;
          execution.released = true;
          execution.unsubscribe?.();
          execution.unsubscribe = null;
        },
      });
      // Resource release may have been replayed synchronously by subscribe().
      if (execution.released) unsubscribe();
      else execution.unsubscribe = unsubscribe;
      if (!accepted || execution.abort.signal.aborted) await this.stopOwnedProcess(execution);
    } catch (error) {
      if (error instanceof OwnedRuntimeCleanupError) execution.cleanup = error.release;
      else if (!execution.process) execution.released = true;
      this.ports.registry.observeStartFailed(
        token,
        error instanceof Error ? error.message : String(error)
      );
      if (execution.cleanup) this.ports.registry.observeMemberReleaseFailed(token);
      else if (execution.released) this.ports.registry.observeMemberReleased(token);
    }
  }

  private stopOwnedProcess(execution: Execution): Promise<void> {
    if (execution.stop) return execution.stop;
    if (execution.released) return Promise.resolve();
    if (!execution.process && !execution.cleanup) return Promise.resolve();
    execution.stop = Promise.resolve()
      .then(async () => {
        if (execution.process) {
          try {
            await execution.process.stop();
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
