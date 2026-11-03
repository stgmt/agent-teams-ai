import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { ownedCleanup } from '../../infrastructure/ownedCleanup';
import { rejectAfterOwnedCleanup } from '../../infrastructure/rejectAfterOwnedCleanup';

import type { MemberProcessToken, OwnedProcessIdentity } from '../../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberRuntimeEvents,
  MemberRuntimePort,
  OwnedMemberProcess,
} from '../../../core/application/ports/MemberRuntimePorts';

export interface NodeMemberLaunchPlan {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  connectionTimeoutMs?: number;
  observeOutput?(line: string, stream: 'stdout' | 'stderr'): 'connected' | 'connection-lost' | null;
  connection?: {
    subscribe(
      identity: Readonly<OwnedProcessIdentity>,
      events: { connected(): void; failed(error: Error): void }
    ): () => void;
  };
  afterSpawn?(identity: Readonly<OwnedProcessIdentity>, signal: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

export interface NodeMemberLaunchPlanner {
  prepare(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<NodeMemberLaunchPlan>;
  observeOutput?(line: string, stream: 'stdout' | 'stderr'): 'connected' | 'connection-lost' | null;
}

type Observation =
  | { kind: 'connected' }
  | { kind: 'connection-lost' }
  | { kind: 'failed'; error: string }
  | { kind: 'release-failed'; error: string }
  | { kind: 'released' }
  | { kind: 'exit'; code: number | null; signal: string | null };

export type NodeMemberProcessAdmission = <T>(
  token: MemberProcessToken,
  operation: () => Promise<T>
) => Promise<T>;

export interface NodeMemberTerminationPolicy {
  gracePeriodMs: number;
  forceExitTimeoutMs: number;
}

export class NodeMemberRuntime implements MemberRuntimePort {
  private readonly terminationPolicy: Readonly<NodeMemberTerminationPolicy>;

  constructor(
    private readonly planner: NodeMemberLaunchPlanner,
    private readonly admit: NodeMemberProcessAdmission,
    terminationPolicy: Readonly<NodeMemberTerminationPolicy> = {
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
    this.terminationPolicy = Object.freeze({ ...terminationPolicy });
  }

  async spawn(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberProcess> {
    const plan = await this.planner.prepare(settings, token, signal);
    const dispose = ownedCleanup(async () => {
      await plan.dispose?.();
    });
    try {
      return await this.admit(token, () => this.spawnPrepared(plan, signal, dispose));
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
  }

  private async spawnPrepared(
    plan: NodeMemberLaunchPlan,
    signal: AbortSignal,
    dispose: () => Promise<void>
  ): Promise<OwnedMemberProcess> {
    let child: ReturnType<typeof spawn>;
    try {
      if (
        plan.connectionTimeoutMs !== undefined &&
        (!Number.isSafeInteger(plan.connectionTimeoutMs) || plan.connectionTimeoutMs < 1)
      )
        throw new Error('Runtime connection deadline must be a positive integer');
      signal.throwIfAborted();
      child = spawn(plan.executable, [...plan.args], {
        cwd: plan.cwd,
        env: { ...plan.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
    let bufferedConnection: Observation | null = null;
    let bufferedExit: Observation | null = null;
    let bufferedFailure: Observation | null = null;
    let bufferedReleaseFailure: Observation | null = null;
    let bufferedReleased = false;
    let listener: MemberRuntimeEvents | null = null;
    let terminal = false;
    let stopping: Promise<void> | null = null;
    let termination: Promise<void> | null = null;
    let disconnect: (() => void) | null = null;
    let observationError: Error | null = null;
    let cleanupError: Error | null = null;
    let resourcesReleased = false;
    let registration = Promise.resolve();
    let connectionDeadline: ReturnType<typeof setTimeout> | null = null;
    const clearConnectionDeadline = (): void => {
      if (connectionDeadline) clearTimeout(connectionDeadline);
      connectionDeadline = null;
    };
    const processLifetime = new AbortController();
    const forwardAbort = (): void => {
      clearConnectionDeadline();
      processLifetime.abort();
    };
    signal.addEventListener('abort', forwardAbort, { once: true });
    if (signal.aborted) forwardAbort();
    const reportFailure = (error: unknown): void => {
      clearConnectionDeadline();
      const failure =
        error instanceof Error ? error : new Error('Owned runtime observation failed');
      observationError ??= failure;
      deliver({ kind: 'failed', error: failure.message });
    };
    const waitForProcessExit = (timeoutMs: number): Promise<boolean> => {
      if (terminal) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const onExit = (): void => finish(true);
        const finish = (didExit: boolean): void => {
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          resolve(didExit);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once('exit', onExit);
      });
    };
    const terminate = (): Promise<void> => {
      termination ??= Promise.resolve()
        .then(async () => {
          clearConnectionDeadline();
          processLifetime.abort();
          if (terminal) return;
          // Keep the live handle: never rediscover a target by team name or PID.
          // Windows terminates abruptly for both signals; POSIX may require escalation.
          child.kill('SIGTERM');
          if (await waitForProcessExit(this.terminationPolicy.gracePeriodMs)) return;
          if (!terminal) child.kill('SIGKILL');
          if (!(await waitForProcessExit(this.terminationPolicy.forceExitTimeoutMs)))
            throw new Error('Owned member process exceeded its termination deadline');
        })
        .catch((error: unknown) => {
          termination = null;
          reportFailure(error);
          throw error;
        });
      return termination;
    };
    const failObservation = (error: unknown): void => {
      reportFailure(error);
      if (!terminal) void terminate().catch(() => undefined);
    };
    let completeStop!: () => void;
    const exited = new Promise<void>((resolve) => {
      completeStop = resolve;
    });
    function deliver(observation: Observation): void {
      if (observation.kind === 'connected' || observation.kind === 'exit')
        clearConnectionDeadline();
      if (!listener) {
        if (observation.kind === 'exit') bufferedExit = observation;
        else if (observation.kind === 'failed') bufferedFailure = observation;
        else if (observation.kind === 'release-failed') bufferedReleaseFailure = observation;
        else if (observation.kind === 'released') bufferedReleased = true;
        else bufferedConnection = observation;
      } else if (observation.kind === 'exit') {
        listener.exited(observation);
      } else if (observation.kind === 'failed') {
        listener.failed(observation.error);
      } else if (observation.kind === 'release-failed') {
        listener.releaseFailed(observation.error);
      } else if (observation.kind === 'released') {
        listener.released();
      } else if (observation.kind === 'connected') {
        listener.connected();
      } else {
        listener.connectionLost();
      }
    }
    const releaseResources = async (): Promise<void> => {
      try {
        await dispose();
        cleanupError = null;
        if (!resourcesReleased) {
          resourcesReleased = true;
          deliver({ kind: 'released' });
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error('Owned runtime cleanup failed');
        deliver({ kind: 'release-failed', error: cleanupError.message });
        throw cleanupError;
      }
    };
    let lastConnection: Observation['kind'] | null = null;
    // A member that dies on its own explains itself on stderr and nowhere else; without
    // this tail the failure reaches the user as "no error" and the reason is lost.
    const stderrTail: string[] = [];
    const rememberStderr = (line: string): void => {
      const text = line.trim();
      if (!text) return;
      stderrTail.push(text.length > 500 ? `${text.slice(0, 500)}…` : text);
      if (stderrTail.length > 20) stderrTail.shift();
    };
    const attachOutput = (stream: 'stdout' | 'stderr'): void => {
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let discardLine = false;
      const observeLine = (line: string): void => {
        // A terminal process observation cannot be undone by output still draining from a pipe.
        if (terminal || line.length > 1024 * 1024) return;
        if (stream === 'stderr') rememberStderr(line);
        try {
          const observation = plan.observeOutput
            ? plan.observeOutput(line.replace(/\r$/, ''), stream)
            : this.planner.observeOutput?.(line.replace(/\r$/, ''), stream);
          if (observation && observation !== lastConnection) {
            lastConnection = observation;
            deliver({ kind: observation });
          }
        } catch (error) {
          failObservation(error);
        }
      };
      child[stream]!.on('data', (data: Buffer) => {
        let decoded = decoder.write(data);
        if (discardLine) {
          const boundary = decoded.indexOf('\n');
          if (boundary < 0) return;
          decoded = decoded.slice(boundary + 1);
          discardLine = false;
        }
        carry += decoded;
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        // Discard the whole oversized line, never reinterpret its tail as a new event.
        if (carry.length > 1024 * 1024) {
          carry = '';
          discardLine = true;
        }
        for (const line of lines) observeLine(line);
      });
      child[stream]!.once('end', () => {
        carry += decoder.end();
        if (carry && !discardLine) observeLine(carry);
        carry = '';
      });
    };
    attachOutput('stdout');
    attachOutput('stderr');
    child.once('exit', (code, exitSignal) => {
      terminal = true;
      processLifetime.abort();
      signal.removeEventListener('abort', forwardAbort);
      disconnect?.();
      // The member's last words travel with the exit; the owner decides whether they
      // explain a failed run, so an intentional stop stays quiet.
      deliver({
        kind: 'exit',
        code,
        signal: exitSignal,
        ...(stderrTail.length ? { stderrTail: [...stderrTail] } : {}),
      });
      void registration
        .then(releaseResources)
        .catch(() => undefined)
        .finally(completeStop);
    });
    child.stdin?.on('error', failObservation);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      terminal = true;
      processLifetime.abort();
      signal.removeEventListener('abort', forwardAbort);
      return rejectAfterOwnedCleanup(error, dispose);
    }
    child.on('error', failObservation);
    if (!child.pid) {
      await dispose();
      throw new Error('Member process started without an owned PID');
    }
    const identity = Object.freeze({ pid: child.pid, birthId: randomUUID() });
    if (!terminal && !signal.aborted && plan.connectionTimeoutMs !== undefined) {
      connectionDeadline = setTimeout(() => {
        failObservation(new Error('Owned runtime did not connect before the launch deadline'));
      }, plan.connectionTimeoutMs);
      connectionDeadline.unref();
    }
    if (!terminal && plan.connection) {
      try {
        disconnect = plan.connection.subscribe(identity, {
          connected: () => {
            if (!terminal) deliver({ kind: 'connected' });
          },
          failed: failObservation,
        });
      } catch (error) {
        failObservation(error);
      }
    }
    if (!terminal && plan.afterSpawn) {
      registration = Promise.resolve()
        .then(() => {
          processLifetime.signal.throwIfAborted();
          return plan.afterSpawn!(identity, processLifetime.signal);
        })
        .catch((error: unknown) => {
          if (!processLifetime.signal.aborted) failObservation(error);
        });
    }
    return {
      identity,
      subscribe(events) {
        if (listener) throw new Error('The member process already has a lifecycle subscriber');
        listener = events;
        if (bufferedConnection) deliver(bufferedConnection);
        if (bufferedFailure) deliver(bufferedFailure);
        if (bufferedExit) deliver(bufferedExit);
        if (bufferedReleaseFailure) deliver(bufferedReleaseFailure);
        if (bufferedReleased) deliver({ kind: 'released' });
        bufferedConnection = null;
        bufferedFailure = null;
        bufferedReleaseFailure = null;
        bufferedExit = null;
        bufferedReleased = false;
        return () => {
          if (listener === events) listener = null;
        };
      },
      async writeInput(line) {
        if (!line || /[\r\n]/.test(line) || Buffer.byteLength(line) > 16 * 1024 * 1024)
          throw new Error('Runtime input must be one bounded line');
        if (terminal || stopping || processLifetime.signal.aborted || !child.stdin?.writable)
          throw new Error('Owned runtime input is not writable');
        const stdin = child.stdin;
        await new Promise<void>((resolve, reject) => {
          const onExit = (): void =>
            reject(new Error('Owned runtime input closed before delivery'));
          child.once('exit', onExit);
          stdin.write(line + '\n', (error) => {
            child.removeListener('exit', onExit);
            if (error) reject(error);
            else resolve();
          });
        });
      },
      stop() {
        const retryCleanup = terminal && cleanupError !== null;
        stopping ??= (async () => {
          await terminate();
          await exited;
          if (retryCleanup && cleanupError) await releaseResources();
          if (cleanupError) throw cleanupError;
          if (observationError) throw observationError;
        })().catch((error: unknown) => {
          stopping = null;
          throw error;
        });
        return stopping;
      },
    };
  }
}
