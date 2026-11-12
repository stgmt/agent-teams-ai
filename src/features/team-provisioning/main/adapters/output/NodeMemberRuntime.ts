import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';

import { inspectProcessByPid } from '@main/utils/processInspection';

import { ownedCleanup } from '../../infrastructure/ownedCleanup';
import { rejectAfterOwnedCleanup } from '../../infrastructure/rejectAfterOwnedCleanup';

import type { MemberProcessToken, OwnedProcessIdentity } from '../../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberRuntimeEvents,
  MemberRuntimePort,
  OwnedMemberProcess,
} from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeClaudeSdkHost, NativeClaudeSdkOutputEvidence } from './NativeClaudeSdkHost';

export interface NodeMemberConnectionPlan {
  sdk: {
    host: NativeClaudeSdkHost;
    token: Readonly<MemberProcessToken>;
    stdoutPath: string;
    stderrPath: string;
  };
  connectionTimeoutMs?: number;
  observeOutput?(
    line: string,
    stream: 'stdout' | 'stderr',
    evidence?: NativeClaudeSdkOutputEvidence
  ): 'connected' | 'connection-lost' | null;
  connection?: {
    subscribe(
      identity: Readonly<OwnedProcessIdentity>,
      events: { connected(): void; failed(error: Error): void }
    ): () => void;
  };
  dispose?(): Promise<void>;
}

export interface NodeMemberLaunchPlan extends NodeMemberConnectionPlan {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  afterSpawn?(identity: Readonly<OwnedProcessIdentity>, signal: AbortSignal): Promise<void>;
}

export interface NodeMemberLaunchPlanner {
  prepare(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<NodeMemberLaunchPlan>;
  recover(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal,
    identity: Readonly<OwnedProcessIdentity>
  ): Promise<NodeMemberConnectionPlan>;
  observeOutput?(line: string, stream: 'stdout' | 'stderr'): 'connected' | 'connection-lost' | null;
}

export type NodeMemberProcessAdmission = <T>(
  token: MemberProcessToken,
  operation: () => Promise<T>
) => Promise<T>;
export interface NodeMemberTerminationPolicy {
  gracePeriodMs: number;
  forceExitTimeoutMs: number;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Claude processes outlive the app: SDK owns I/O, while OS files own diagnostic streams. */
export class NodeMemberRuntime implements MemberRuntimePort {
  constructor(
    private readonly planner: NodeMemberLaunchPlanner,
    private readonly admit: NodeMemberProcessAdmission,
    private readonly terminationPolicy: Readonly<NodeMemberTerminationPolicy> = {
      gracePeriodMs: 2000,
      forceExitTimeoutMs: 5000,
    }
  ) {
    if (
      [terminationPolicy.gracePeriodMs, terminationPolicy.forceExitTimeoutMs].some(
        (value) => !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647
      )
    )
      throw new Error('Runtime termination deadlines must be positive integers');
  }

  observeExisting(
    identity: Readonly<OwnedProcessIdentity>,
    startedAt: number,
    exited: () => void
  ): () => void {
    let checking = false;
    let disposed = false;
    const inspect = async (): Promise<void> => {
      if (checking || disposed) return;
      checking = true;
      try {
        const result = await inspectProcessByPid(identity.pid);
        if (
          !disposed &&
          (result.status === 'not_found' ||
            (result.status === 'found' &&
              result.startedAt !== undefined &&
              result.startedAt !== startedAt))
        ) {
          disposed = true;
          clearInterval(timer);
          exited();
        }
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => {
      void inspect().catch(() => undefined);
    }, 2_000);
    timer.unref();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }

  async spawn(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberProcess> {
    const plan = await this.planner.prepare(settings, token, signal);
    let terminateFailedSpawn: (() => Promise<void>) | undefined;
    const dispose = ownedCleanup(async () => {
      await terminateFailedSpawn?.();
      await plan.dispose?.();
    });
    try {
      return await this.admit(token, async () => {
        signal.throwIfAborted();
        const descriptors: number[] = [];
        let child: ChildProcess;
        try {
          descriptors.push(openSync(plan.sdk.stdoutPath, 'a', 0o600));
          descriptors.push(openSync(plan.sdk.stderrPath, 'a', 0o600));
          child = spawn(plan.executable, [...plan.args], {
            cwd: plan.cwd,
            env: { ...plan.env },
            shell: false,
            windowsHide: true,
            detached: true,
            stdio: ['ignore', descriptors[0], descriptors[1]],
          });
        } finally {
          for (const descriptor of descriptors) closeSync(descriptor);
        }
        const terminated = deferred<void>();
        child.once('exit', () => terminated.resolve());
        terminateFailedSpawn = async () => {
          if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGTERM');
          const graceful = deferred<void>();
          const timer = setTimeout(graceful.resolve, this.terminationPolicy.gracePeriodMs);
          try {
            await Promise.race([terminated.promise, graceful.promise]);
          } finally {
            clearTimeout(timer);
          }
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill('SIGKILL');
          const forced = deferred<never>();
          const forceTimer = setTimeout(
            () =>
              forced.reject(new Error('Failed native launch exceeded its termination deadline')),
            this.terminationPolicy.forceExitTimeoutMs
          );
          try {
            await Promise.race([terminated.promise, forced.promise]);
          } finally {
            clearTimeout(forceTimer);
          }
        };
        const spawned = deferred<void>();
        child.once('spawn', spawned.resolve);
        child.once('error', spawned.reject);
        await spawned.promise;
        child.unref();
        if (!child.pid) throw new Error('Member process started without an owned PID');
        const identity = Object.freeze({ pid: child.pid, birthId: randomUUID() });
        const inspection = await inspectProcessByPid(identity.pid);
        if (inspection.status !== 'found' || inspection.startedAt === undefined) {
          throw new Error('Native SDK requires verified OS process birth');
        }
        signal.throwIfAborted();
        // Persist the existing native config/proof first; raw upgrade admission waits for registration.
        await plan.afterSpawn?.(identity, signal);
        signal.throwIfAborted();
        await plan.sdk.host.registerProcess(token, identity, inspection.startedAt);
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Native SDK process exited during registration');
        const handle = this.connect(
          plan,
          identity,
          inspection.startedAt,
          signal,
          dispose,
          (exited) => {
            const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
              void exited(code, exitSignal);
            };
            child.once('exit', onExit);
            return () => {
              child.removeListener('exit', onExit);
            };
          },
          (exitSignal) => {
            child.kill(exitSignal);
          }
        );
        terminateFailedSpawn = undefined;
        return handle;
      });
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
  }

  async reconnect(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>,
    startedAt: number,
    signal: AbortSignal
  ): Promise<OwnedMemberProcess> {
    return this.admit(token, async () => {
      const inspection = await inspectProcessByPid(identity.pid);
      if (inspection.status !== 'found' || inspection.startedAt !== startedAt)
        throw new Error('Surviving native process birth is not current');
      const plan = await this.planner.recover(settings, token, signal, identity);
      const dispose = ownedCleanup(async () => {
        await plan.dispose?.();
      });
      try {
        signal.throwIfAborted();
        await plan.sdk.host.registerProcess(token, identity, startedAt);
        signal.throwIfAborted();
        return this.connect(
          plan,
          identity,
          startedAt,
          signal,
          dispose,
          (exited) =>
            this.observeExisting(identity, startedAt, () => {
              void exited(null, null);
            }),
          (exitSignal) => {
            process.kill(identity.pid, exitSignal);
          }
        );
      } catch (error) {
        return rejectAfterOwnedCleanup(error, dispose);
      }
    });
  }

  private connect(
    plan: NodeMemberConnectionPlan,
    identity: Readonly<OwnedProcessIdentity>,
    startedAt: number,
    signal: AbortSignal,
    dispose: () => Promise<void>,
    watchExit: (
      exited: (code: number | null, exitSignal: string | null) => Promise<void>
    ) => () => void,
    kill: (signal: NodeJS.Signals) => void
  ): OwnedMemberProcess {
    let listener: MemberRuntimeEvents | null = null;
    let connection: 'connected' | 'connectionLost' | null = null;
    let failure: string | null = null;
    let exit: {
      code: number | null;
      signal: string | null;
      stderrTail?: readonly string[];
    } | null = null;
    let observingExit = false;
    let released = false;
    let releaseError: string | null = null;
    let stopping: Promise<void> | null = null;
    let transportOpen = false;
    let bootstrapConfirmed = false;
    const exitCompletion = deferred<void>();
    const notifyConnection = (): void => {
      const next = transportOpen && bootstrapConfirmed ? 'connected' : 'connectionLost';
      if (next === connection || (connection === null && next === 'connectionLost')) return;
      connection = next;
      if (next === 'connected') clearTimeout(deadline);
      listener?.[next]();
    };
    const reportFailure = (error: Error): void => {
      failure = error.message;
      listener?.failed(failure);
    };
    const fail = (error: Error): void => {
      reportFailure(error);
      clearTimeout(deadline);
      queueMicrotask(() => {
        void stop().catch(() => undefined);
      });
    };
    const deadline = setTimeout(() => {
      if (!bootstrapConfirmed || !transportOpen)
        fail(new Error('Owned runtime did not confirm bootstrap before the launch deadline'));
    }, plan.connectionTimeoutMs ?? 120_000);
    deadline.unref();
    const unsubscribe = plan.sdk.host.subscribe(plan.sdk.token, {
      opened: () => {
        transportOpen = true;
        notifyConnection();
      },
      output: (line, evidence) => {
        try {
          const observation = plan.observeOutput?.(line, 'stdout', evidence);
          if (observation === 'connected') bootstrapConfirmed = true;
          else if (observation === 'connection-lost') bootstrapConfirmed = false;
          notifyConnection();
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Native SDK output observation failed'));
        }
      },
      disconnected: () => {
        transportOpen = false;
        notifyConnection();
      },
      failed: fail,
    });
    const disconnectProof = plan.connection?.subscribe(identity, {
      connected: () => {
        bootstrapConfirmed = true;
        notifyConnection();
      },
      failed: fail,
    });
    const release = async (): Promise<void> => {
      if (released) return;
      try {
        await dispose();
        released = true;
        releaseError = null;
        listener?.released();
      } catch (error) {
        releaseError = error instanceof Error ? error.message : 'Native process cleanup failed';
        listener?.releaseFailed(releaseError);
      }
    };
    const unwatch = watchExit(async (code, exitSignal) => {
      if (exit || observingExit) return;
      observingExit = true;
      const terminal: Parameters<MemberRuntimeEvents['exited']>[0] = { code, signal: exitSignal };
      try {
        const diagnostics = await open(plan.sdk.stderrPath, 'r');
        try {
          const { size } = await diagnostics.stat();
          const length = Math.min(size, 8192);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await diagnostics.read(buffer, 0, length, size - length);
          const stderrTail = buffer
            .toString('utf8', 0, bytesRead)
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(-20);
          if (stderrTail.length) terminal.stderrTail = stderrTail;
        } finally {
          await diagnostics.close();
        }
      } catch (error) {
        reportFailure(
          error instanceof Error ? error : new Error('Native process diagnostics could not be read')
        );
      }
      exit = terminal;
      clearTimeout(deadline);
      unsubscribe();
      disconnectProof?.();
      unwatch();
      listener?.exited(exit);
      await release();
      exitCompletion.resolve();
    });
    const abort = (): void => {
      clearTimeout(deadline);
    };
    signal.addEventListener('abort', abort, { once: true });
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        if (!exit && !observingExit) {
          const inspection = await inspectProcessByPid(identity.pid);
          if (inspection.status === 'not_found') await exitCompletion.promise;
          else if (!exit && !observingExit) {
            if (inspection.status !== 'found' || inspection.startedAt !== startedAt)
              throw new Error('Native SDK stop refused stale OS process birth');
            kill('SIGTERM');
            const delay = deferred<void>();
            const timer = setTimeout(delay.resolve, this.terminationPolicy.gracePeriodMs);
            await Promise.race([exitCompletion.promise, delay.promise]);
            clearTimeout(timer);
            if (!exit && !observingExit) {
              const current = await inspectProcessByPid(identity.pid);
              if (current.status === 'not_found') await exitCompletion.promise;
              else if (!exit && !observingExit) {
                if (current.status !== 'found' || current.startedAt !== startedAt)
                  throw new Error('Native SDK escalation refused stale OS process birth');
                kill('SIGKILL');
                const timeout = deferred<never>();
                const forceTimer = setTimeout(
                  () =>
                    timeout.reject(
                      new Error('Owned member process exceeded its termination deadline')
                    ),
                  this.terminationPolicy.forceExitTimeoutMs
                );
                try {
                  await Promise.race([exitCompletion.promise, timeout.promise]);
                } finally {
                  clearTimeout(forceTimer);
                }
              }
            }
          }
        }
        await exitCompletion.promise;
        signal.removeEventListener('abort', abort);
        if (releaseError) {
          await release();
          if (!released) throw new Error(releaseError);
        }
        if (failure) throw new Error(failure);
      })().catch((error: unknown) => {
        stopping = null;
        if (error instanceof Error && error.message !== failure && error.message !== releaseError)
          reportFailure(error);
        throw error;
      });
      return stopping;
    };
    return {
      identity,
      subscribe(events) {
        if (listener) throw new Error('The member process already has a lifecycle subscriber');
        listener = events;
        if (connection) events[connection]();
        if (failure) events.failed(failure);
        if (exit) events.exited(exit);
        if (releaseError) events.releaseFailed(releaseError);
        if (released) events.released();
        return () => {
          if (listener === events) listener = null;
        };
      },
      async writeInput(line, operationId) {
        if (exit || observingExit || stopping || signal.aborted)
          throw new Error('Owned runtime input is no longer current');
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('Native SDK requires JSON input');
        const event = message as Record<string, unknown>;
        if (event.type === 'user' && (!bootstrapConfirmed || !transportOpen))
          throw new Error('Native SDK member bootstrap is not ready');
        let uuid = operationId ?? event.uuid;
        if (typeof uuid !== 'string' || !uuid) {
          const response = event.response;
          const requestId =
            event.type === 'control_request'
              ? event.request_id
              : event.type === 'control_response' && response && typeof response === 'object'
                ? (response as Record<string, unknown>).request_id
                : null;
          if (typeof requestId !== 'string' || !requestId)
            throw new Error('Native SDK input requires its durable command UUID');
          const hash = createHash('sha256')
            .update(`${plan.sdk.token.operationId}:${event.type}:${requestId}`)
            .digest('hex');
          uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        }
        await plan.sdk.host.deliver(plan.sdk.token, String(uuid), line);
      },
      stop,
    };
  }
}
