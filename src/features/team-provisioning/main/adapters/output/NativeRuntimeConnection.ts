import { watch } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

import { validateBootstrapRuntimeProofEnvelope } from '@main/services/team/bootstrap/BootstrapProofValidation';

import type { OwnedProcessIdentity } from '../../../contracts';
import type { FSWatcher } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface NativeRuntimeConnectionExpected {
  eventsPath: string;
  teamName: string;
  memberName: string;
  runId: string;
  proofToken: string;
  contextHash: string;
  briefingHash: string;
  boundaryMs: number;
}

export interface NativeRuntimeConnectionEvents {
  connected(): void;
  failed(error: Error): void;
}

export function matchesNativeRuntimeProof(
  value: unknown,
  identity: Readonly<OwnedProcessIdentity>,
  expected: Readonly<NativeRuntimeConnectionExpected>
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    event.version !== 1 ||
    event.pid !== identity.pid ||
    event.agentName !== expected.memberName ||
    event.bootstrapRunId !== expected.runId ||
    event.source !== 'native_app_managed_bootstrap_private_turn'
  )
    return false;
  return validateBootstrapRuntimeProofEnvelope({
    event,
    expected: {
      teamName: expected.teamName,
      boundaryMs: expected.boundaryMs,
      proofToken: expected.proofToken,
      proofMode: 'native_app_managed_context',
      contextHash: expected.contextHash,
      briefingHash: expected.briefingHash,
      runId: expected.runId,
    },
  });
}

/** One immutable event file belongs to one owned process attempt, never a discovery query. */
export class NativeRuntimeConnection {
  private subscribed = false;

  constructor(private readonly expected: Readonly<NativeRuntimeConnectionExpected>) {}

  subscribe(
    identity: Readonly<OwnedProcessIdentity>,
    events: NativeRuntimeConnectionEvents
  ): () => void {
    if (this.subscribed) throw new Error('Native runtime connection already has a subscriber');
    this.subscribed = true;
    let stopped = false;
    let connected = false;
    let watcher: FSWatcher | null = null;
    let handle: FileHandle | null = null;
    let pending = false;
    let reading = false;
    let offset = 0;
    let carry = '';
    const decoder = new StringDecoder('utf8');
    const dispose = (): void => {
      if (stopped) return;
      stopped = true;
      watcher?.close();
      if (handle) void handle.close().catch(() => {});
    };
    const fail = (error: unknown): void => {
      if (stopped) return;
      dispose();
      events.failed(
        error instanceof Error ? error : new Error('Native runtime evidence could not be read')
      );
    };
    const observe = (line: string): void => {
      if (stopped || !line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const event = value as Record<string, unknown>;
        const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
        // Failure may precede context loading. The private per-attempt file and owned PID
        // still identify its child; any identity fields present must match. This never grants readiness.
        if (
          event.version === 1 &&
          event.type === 'failed' &&
          event.pid === identity.pid &&
          (event.teamName === undefined || event.teamName === this.expected.teamName) &&
          (event.agentName === undefined || event.agentName === this.expected.memberName) &&
          (event.runId === undefined || event.runId === this.expected.runId) &&
          (event.bootstrapRunId === undefined || event.bootstrapRunId === this.expected.runId) &&
          Number.isFinite(timestamp) &&
          timestamp >= this.expected.boundaryMs
        ) {
          fail(
            new Error(
              typeof event.detail === 'string' && event.detail.trim()
                ? event.detail
                : 'Native member bootstrap failed'
            )
          );
          return;
        }
      }
      if (!connected && matchesNativeRuntimeProof(value, identity, this.expected)) {
        connected = true;
        events.connected();
      }
    };
    const drain = async (): Promise<void> => {
      if (reading || stopped || !handle) return;
      reading = true;
      try {
        while (pending && !stopped) {
          pending = false;
          const [current, owned] = await Promise.all([
            lstat(this.expected.eventsPath),
            handle.stat(),
          ]);
          if (stopped) return;
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.dev !== owned.dev ||
            current.ino !== owned.ino ||
            owned.size < offset
          ) {
            throw new Error('Native runtime event file was replaced or truncated');
          }
          const buffer = Buffer.alloc(64 * 1024);
          while (offset < owned.size && !stopped) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, owned.size - offset),
              offset
            );
            if (!bytesRead) throw new Error('Native runtime event file was replaced or truncated');
            offset += bytesRead;
            carry += decoder.write(buffer.subarray(0, bytesRead));
            const lines = carry.split('\n');
            carry = lines.pop() ?? '';
            if (carry.length > 16 * 1024 || lines.some((line) => line.length > 16 * 1024)) {
              throw new Error('Native runtime event exceeds the bounded line size');
            }
            for (const line of lines) observe(line);
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
      }
    };
    const changed = (): void => {
      pending = true;
      void drain();
    };
    void (async () => {
      try {
        const before = await lstat(this.expected.eventsPath);
        if (!before.isFile() || before.isSymbolicLink())
          throw new Error('Native runtime evidence must be a regular file');
        const opened = await open(this.expected.eventsPath, 'r');
        if (stopped) {
          await opened.close();
          return;
        }
        handle = opened;
        const owned = await opened.stat();
        if (before.dev !== owned.dev || before.ino !== owned.ino)
          throw new Error('Native runtime event file was replaced or truncated');
        watcher = watch(this.expected.eventsPath, (event) => {
          if (event === 'rename')
            fail(new Error('Native runtime event file was replaced or truncated'));
          else changed();
        });
        watcher.on('error', fail);
        changed();
      } catch (error) {
        fail(error);
      }
    })();
    return dispose;
  }
}
