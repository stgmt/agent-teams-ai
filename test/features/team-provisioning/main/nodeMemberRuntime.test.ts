// @vitest-environment node
import { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import {
  type NodeMemberLaunchPlan,
  NodeMemberRuntime,
} from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

const token = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
  memberName: 'TEST-member',
  generation: 1,
  operationId: 'TEST-start',
};
const settings = {
  team: token,
  memberName: token.memberName,
  configurationRevision: 'TEST-revision',
  providerId: 'TEST-node-process',
  model: null,
  workingDirectory: process.cwd(),
  instructions: 'TEST',
};
const context = new BoundControlContext('TEST-app', 'TEST-root');
const testOwner = context.snapshot();
Object.assign(token, testOwner);

async function admit<T>(expected: typeof token, operation: () => Promise<T>): Promise<T> {
  const release = context.admit(expected);
  try {
    return await operation();
  } finally {
    release();
  }
}

function runtime(code: string) {
  return new NodeMemberRuntime(
    {
      prepare(): Promise<NodeMemberLaunchPlan> {
        return Promise.resolve({
          executable: process.execPath,
          args: ['-e', code],
          cwd: process.cwd(),
          env: process.env,
        });
      },
      observeOutput: (line) => (line.trim() === 'TEST-ready' ? 'connected' : null),
    },
    admit
  );
}

async function settleWithin<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('TEST stop did not settle')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('owned Node member process adapter', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid termination deadlines %s before preparing a process',
    (deadline) => {
      const planner = { prepare: vi.fn() };
      expect(
        () =>
          new NodeMemberRuntime(planner, admit, {
            gracePeriodMs: deadline,
            forceExitTimeoutMs: 100,
          })
      ).toThrow('termination deadlines');
      expect(
        () =>
          new NodeMemberRuntime(planner, admit, {
            gracePeriodMs: 100,
            forceExitTimeoutMs: deadline,
          })
      ).toThrow('termination deadlines');
      expect(planner.prepare).not.toHaveBeenCalled();
    }
  );

  it('replays real readiness and exit observations without inventing a live process', async () => {
    const process = await runtime("console.log('TEST-ready'); process.exitCode=7").spawn(
      settings,
      token,
      new AbortController().signal
    );
    const connected = vi.fn();
    const exited = vi.fn();
    process.subscribe({
      connected,
      exited,
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
    });
    await vi.waitFor(() =>
      expect(exited).toHaveBeenCalledWith({ kind: 'exit', code: 7, signal: null })
    );
    expect(connected).toHaveBeenCalledOnce();
    expect(process.identity.pid).toBeGreaterThan(0);
    expect(process.identity.birthId).toBeTruthy();
    await process.stop();
  });

  it('stops only the child it owns and preserves its real terminal observation', async () => {
    const process = await runtime('setInterval(()=>{},1000)').spawn(
      settings,
      token,
      new AbortController().signal
    );
    const exited = vi.fn();
    process.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
      exited,
    });
    await Promise.all([process.stop(), process.stop()]);
    expect(exited).toHaveBeenCalledOnce();
  });

  it('parses the last output line even when the child omits a newline', async () => {
    const process = await runtime("process.stdout.write('TEST-ready')").spawn(
      settings,
      token,
      new AbortController().signal
    );
    const connected = vi.fn();
    const exited = vi.fn();
    process.subscribe({
      connected,
      exited,
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
    });
    await vi.waitFor(() => expect(exited).toHaveBeenCalled(), { timeout: 10_000 });
    expect(connected).toHaveBeenCalledOnce();
  });

  it('keeps UTF-8 readiness text intact across output chunks', async () => {
    const bytes = [...Buffer.from('Тест-готов')];
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: [
              '-e',
              `const b=Buffer.from(${JSON.stringify(bytes)});process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)`,
            ],
            cwd: process.cwd(),
            env: process.env,
          });
        },
        observeOutput: (line) => (line === 'Тест-готов' ? 'connected' : null),
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const connected = vi.fn();
    const exited = vi.fn();
    child.subscribe({
      connected,
      exited,
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
    });
    await vi.waitFor(() => expect(exited).toHaveBeenCalled(), { timeout: 5_000 });
    expect(connected).toHaveBeenCalledOnce();
  });

  it('binds a started child before private bootstrap delivery and releases resources on its real exit', async () => {
    const disposed = vi.fn(() => Promise.resolve());
    const bootstrapped = vi.fn<NonNullable<NodeMemberLaunchPlan['afterSpawn']>>(() =>
      Promise.resolve()
    );
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: process.cwd(),
            env: process.env,
            afterSpawn: bootstrapped,
            dispose: disposed,
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
      exited: vi.fn(),
    });
    await expect.poll(() => bootstrapped.mock.calls.length).toBe(1);
    expect(bootstrapped).toHaveBeenCalledWith(child.identity, expect.any(AbortSignal));
    await child.stop();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('stops the owned child when registration fails instead of leaking it outside lifecycle ownership', async () => {
    const disposed = vi.fn(() => Promise.resolve());
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: process.cwd(),
            env: process.env,
            afterSpawn: () => Promise.reject(new Error('TEST-registration-failed')),
            dispose: disposed,
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const exited = vi.fn();
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
      exited,
    });
    await expect.poll(() => exited.mock.calls.length).toBe(1);
    await expect(child.stop()).rejects.toThrow('TEST-registration-failed');
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('writes one framed input only to its live owned child and rejects writes after stop', async () => {
    const child = await runtime(
      "process.stdin.setEncoding('utf8');process.stdin.on('data',line=>{if(line==='TEST-input\\n')console.log('TEST-ready')});setInterval(()=>{},1000)"
    ).spawn(settings, token, new AbortController().signal);
    const connected = vi.fn();
    child.subscribe({
      connected,
      exited: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
    });
    try {
      await child.writeInput('TEST-input');
      await expect.poll(() => connected.mock.calls.length).toBe(1);
      await expect(child.writeInput('TEST-invalid\nTEST-injected')).rejects.toThrow('line');
    } finally {
      await child.stop();
    }
    await expect(child.writeInput('TEST-input')).rejects.toThrow('writable');
  });

  it('does not release attempt files until private registration has settled after process cancellation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const disposed = vi.fn(() => Promise.resolve());
    const registering = vi.fn(async () => pending);
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: process.cwd(),
            env: process.env,
            afterSpawn: registering,
            dispose: disposed,
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const exited = vi.fn();
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
      exited,
    });
    await expect.poll(() => registering.mock.calls.length).toBe(1);
    let stopped = false;
    const stopping = child.stop().then(() => {
      stopped = true;
    });
    await expect.poll(() => exited.mock.calls.length).toBe(1);
    try {
      expect(disposed).not.toHaveBeenCalled();
      expect(stopped).toBe(false);
    } finally {
      finish();
      await stopping;
    }
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('does not claim resources were released when cleanup fails after the real OS exit', async () => {
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: process.cwd(),
            env: process.env,
            dispose: () => Promise.reject(new Error('TEST-cleanup-failed')),
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const released = vi.fn();
    const releaseFailed = vi.fn();
    const exited = vi.fn();
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed,
      released,
      exited,
    });
    await expect.poll(() => releaseFailed.mock.calls.length).toBe(1);
    expect(exited).toHaveBeenCalledOnce();
    expect(released).not.toHaveBeenCalled();
    await expect(child.stop()).rejects.toThrow('TEST-cleanup-failed');
  });

  it('retains and retries exact failed cleanup without spawning another process or reporting early release', async () => {
    let blocked = true;
    const dispose = vi.fn(() =>
      blocked ? Promise.reject(new Error('TEST transient owned cleanup')) : Promise.resolve()
    );
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: process.cwd(),
            env: process.env,
            dispose,
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const released = vi.fn();
    const releaseFailed = vi.fn();
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      exited: vi.fn(),
      failed: vi.fn(),
      releaseFailed,
      released,
    });
    await expect.poll(() => releaseFailed.mock.calls.length).toBe(1);
    expect(released).not.toHaveBeenCalled();
    await expect(child.stop()).rejects.toThrow('TEST transient owned cleanup');
    blocked = false;
    const before = dispose.mock.calls.length;
    await Promise.all([child.stop(), child.stop()]);
    expect(dispose.mock.calls.length).toBe(before + 1);
    expect(released).toHaveBeenCalledOnce();
    await child.stop();
    expect(dispose.mock.calls.length).toBe(before + 1);
  });

  it('does not reinterpret the tail of an oversized output line as a fresh readiness event', async () => {
    const child = await runtime(
      "process.stdout.write('x'.repeat(1100000),()=>setTimeout(()=>process.stdout.write('TEST-ready\\n'),30))"
    ).spawn(settings, token, new AbortController().signal);
    const connected = vi.fn();
    const exited = vi.fn();
    child.subscribe({
      connected,
      exited,
      connectionLost: vi.fn(),
      failed: vi.fn(),
      releaseFailed: vi.fn(),
      released: vi.fn(),
    });
    await expect.poll(() => exited.mock.calls.length, { timeout: 10_000 }).toBe(1);
    expect(connected).not.toHaveBeenCalled();
    await child.stop();
  });

  it('rejects a stale desktop context after asynchronous preparation and before creating the OS process', async () => {
    const context = new BoundControlContext('TEST-app', 'TEST-root');
    const attempt = { ...token, ...context.snapshot() };
    const disposed = vi.fn(() => Promise.resolve());
    const admit = vi.fn(async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    });
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          context.transportReplaced();
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: process.cwd(),
            env: process.env,
            dispose: disposed,
          });
        },
      },
      admit
    );
    await expect(
      adapter.spawn({ ...settings, team: attempt }, attempt, new AbortController().signal)
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(disposed).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce();
  });

  it('fails and stops only its owned child when connection proof misses the launch deadline', async () => {
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: process.cwd(),
            env: process.env,
            connectionTimeoutMs: 80,
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const failed = vi.fn();
    const exited = vi.fn();
    child.subscribe({
      connected: vi.fn(),
      connectionLost: vi.fn(),
      failed,
      releaseFailed: vi.fn(),
      exited,
      released: vi.fn(),
    });
    try {
      await expect.poll(() => failed.mock.calls.length).toBe(1);
      expect(failed).toHaveBeenCalledWith(
        'Owned runtime did not connect before the launch deadline'
      );
      await expect.poll(() => exited.mock.calls.length).toBe(1);
    } finally {
      await child.stop().catch(() => undefined);
    }
  });

  it('clears the initial connection deadline after exact runtime readiness', async () => {
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', 'setInterval(()=>{},1000)'],
            cwd: process.cwd(),
            env: process.env,
            connectionTimeoutMs: 80,
            connection: {
              subscribe(_identity, events) {
                events.connected();
                return () => undefined;
              },
            },
          });
        },
      },
      admit
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const failed = vi.fn();
    const connected = vi.fn();
    child.subscribe({
      connected,
      connectionLost: vi.fn(),
      failed,
      releaseFailed: vi.fn(),
      exited: vi.fn(),
      released: vi.fn(),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(connected).toHaveBeenCalledOnce();
      expect(failed).not.toHaveBeenCalled();
    } finally {
      await child.stop();
    }
  });

  it.each(['stop', 'connection failure'] as const)(
    'escalates %s only for the exact owned child and waits for its exit and cleanup',
    async (reason) => {
      const observations: string[] = [];
      let failConnection!: (error: Error) => void;
      const disposed = vi.fn(() => {
        observations.push('cleanup');
        return Promise.resolve();
      });
      const adapter = new NodeMemberRuntime(
        {
          prepare(): Promise<NodeMemberLaunchPlan> {
            return Promise.resolve({
              executable: process.execPath,
              args: ['-e', "console.log('TEST-ready');setInterval(()=>{},1000)"],
              cwd: process.cwd(),
              env: process.env,
              observeOutput: (line) => (line === 'TEST-ready' ? ('connected' as const) : null),
              connection: {
                subscribe(_identity, events) {
                  failConnection = events.failed;
                  return () => undefined;
                },
              },
              dispose: disposed,
            });
          },
        },
        admit,
        { gracePeriodMs: 25, forceExitTimeoutMs: 1000 }
      );
      const child = await adapter.spawn(settings, token, new AbortController().signal);
      const other = await runtime("console.log('TEST-ready');setInterval(()=>{},1000)").spawn(
        settings,
        token,
        new AbortController().signal
      );
      const connected = vi.fn();
      const otherConnected = vi.fn();
      const otherExited = vi.fn();
      child.subscribe({
        connected,
        exited: () => observations.push('exit'),
        connectionLost: vi.fn(),
        failed: vi.fn(),
        releaseFailed: vi.fn(),
        released: () => observations.push('released'),
      });
      other.subscribe({
        connected: otherConnected,
        exited: otherExited,
        connectionLost: vi.fn(),
        failed: vi.fn(),
        releaseFailed: vi.fn(),
        released: vi.fn(),
      });
      const kill = ChildProcess.prototype.kill;
      // РИСК: Windows cannot ignore SIGTERM. Only this test child's first signal is withheld;
      // the escalation uses its real OS handle, but this does not prove process-tree containment.
      const signals: (NodeJS.Signals | number | undefined)[] = [];
      let forceOwnedExit: (() => void) | undefined;
      const controlledSignal = vi
        .spyOn(ChildProcess.prototype, 'kill')
        .mockImplementation(function (this: ChildProcess, signal) {
          if (this.pid !== child.identity.pid) return kill.call(this, signal);
          forceOwnedExit = () => {
            if (this.exitCode === null && this.signalCode === null) kill.call(this, 'SIGKILL');
          };
          signals.push(signal);
          return signal === undefined || signal === 'SIGTERM' ? true : kill.call(this, signal);
        });
      try {
        await expect.poll(() => connected.mock.calls.length, { timeout: 5_000 }).toBe(1);
        await expect.poll(() => otherConnected.mock.calls.length, { timeout: 5_000 }).toBe(1);
        if (reason === 'connection failure') {
          failConnection(new Error('TEST connection failed'));
          await expect.poll(() => observations.includes('released'), { timeout: 5_000 }).toBe(true);
        }
        const stopping = child.stop();
        expect(child.stop()).toBe(stopping);
        if (reason === 'connection failure')
          await expect(settleWithin(stopping)).rejects.toThrow('TEST connection failed');
        else await settleWithin(stopping);
        expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(observations).toEqual(['exit', 'cleanup', 'released']);
        expect(disposed).toHaveBeenCalledOnce();
        expect(otherExited).not.toHaveBeenCalled();
      } finally {
        controlledSignal.mockRestore();
        forceOwnedExit?.();
        await Promise.all([child.stop().catch(() => undefined), other.stop()]);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'terminates a real POSIX child that ignores SIGTERM using its owned handle',
    async () => {
      const child = await new NodeMemberRuntime(
        {
          prepare: () =>
            Promise.resolve({
              executable: process.execPath,
              args: [
                '-e',
                "process.on('SIGTERM',()=>{});console.log('TEST-ready');setInterval(()=>{},1000)",
              ],
              cwd: process.cwd(),
              env: process.env,
              observeOutput: (line) => (line === 'TEST-ready' ? ('connected' as const) : null),
            }),
        },
        admit,
        { gracePeriodMs: 25, forceExitTimeoutMs: 1000 }
      ).spawn(settings, token, new AbortController().signal);
      const connected = vi.fn();
      const exited = vi.fn();
      child.subscribe({
        connected,
        exited,
        failed: vi.fn(),
        connectionLost: vi.fn(),
        releaseFailed: vi.fn(),
        released: vi.fn(),
      });
      try {
        await expect.poll(() => connected.mock.calls.length).toBe(1);
        await settleWithin(child.stop());
        expect(exited).toHaveBeenCalledWith({ kind: 'exit', code: null, signal: 'SIGKILL' });
      } finally {
        await child.stop();
      }
    }
  );

  it.each([true, false])('retains ownership after signal result %s', async (signalAccepted) => {
    const disposed = vi.fn(() => Promise.resolve());
    const adapter = new NodeMemberRuntime(
      {
        prepare(): Promise<NodeMemberLaunchPlan> {
          return Promise.resolve({
            executable: process.execPath,
            args: ['-e', "console.log('TEST-ready');setInterval(()=>{},1000)"],
            cwd: process.cwd(),
            env: process.env,
            observeOutput: (line) => (line === 'TEST-ready' ? ('connected' as const) : null),
            dispose: disposed,
          });
        },
      },
      admit,
      { gracePeriodMs: 25, forceExitTimeoutMs: 25 }
    );
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const identity = child.identity;
    const connected = vi.fn();
    const failed = vi.fn();
    const exited = vi.fn();
    const released = vi.fn();
    child.subscribe({
      connected,
      failed,
      exited,
      released,
      connectionLost: vi.fn(),
      releaseFailed: vi.fn(),
    });
    const kill = ChildProcess.prototype.kill;
    let forceOwnedExit: (() => void) | undefined;
    // РИСК: withholding both signals simulates failed OS termination, not a real Windows refusal.
    const controlledSignal = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
      this: ChildProcess,
      signal
    ) {
      if (this.pid !== identity.pid) return kill.call(this, signal);
      forceOwnedExit = () => {
        if (this.exitCode === null && this.signalCode === null) kill.call(this, 'SIGKILL');
      };
      return signalAccepted;
    });
    try {
      await expect.poll(() => connected.mock.calls.length, { timeout: 5_000 }).toBe(1);
      await expect(settleWithin(child.stop())).rejects.toThrow('termination deadline');
      expect(failed).toHaveBeenCalledWith(expect.stringContaining('termination deadline'));
      expect(exited).not.toHaveBeenCalled();
      expect(disposed).not.toHaveBeenCalled();
      expect(released).not.toHaveBeenCalled();
      expect(child.identity).toBe(identity);
    } finally {
      controlledSignal.mockRestore();
      try {
        await expect(settleWithin(child.stop())).rejects.toThrow('termination deadline');
      } finally {
        forceOwnedExit?.();
        await child.stop().catch(() => undefined);
      }
    }
    expect(exited).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
  });

  it('does not start a process after cancellation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      runtime("throw new Error('must not run')").spawn(settings, token, abort.signal)
    ).rejects.toThrow();
  });
});
