// @vitest-environment node
import { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { inspectProcessByPid } from '@main/utils/processInspection';
import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';

import {
  createNodeMemberRuntimeFixture,
  createSdkRuntimePlan,
  deferred,
  rejectUnexpectedRecovery,
} from './nodeMemberRuntimeFixture';

import type {
  ConfiguredMemberLaunch,
  MemberRuntimeEvents,
} from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type {
  NodeMemberLaunchPlan,
  NodeMemberLaunchPlanner,
  NodeMemberTerminationPolicy,
} from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import type { SdkPlanOverrides } from './nodeMemberRuntimeFixture';

const context = new BoundControlContext('TEST-app', 'TEST-root');
const token = {
  ...context.snapshot(),
  teamName: 'TEST-team',
  runId: 'TEST-run',
  memberName: 'TEST-member',
  generation: 1,
  operationId: 'TEST-start',
};
const settings: ConfiguredMemberLaunch = {
  team: token,
  memberName: token.memberName,
  configurationRevision: 'TEST-revision',
  providerId: 'TEST-node-process',
  model: null,
  workingDirectory: process.cwd(),
  instructions: 'TEST',
  specIntegration: { scope: { projects: ['TEST-project'], bindings: [] }, environment: {} },
};

async function admit<T>(expected: typeof token, operation: () => Promise<T>): Promise<T> {
  const release = context.admit(expected);
  try {
    return await operation();
  } finally {
    release();
  }
}

function runtime(
  code: string,
  overrides: SdkPlanOverrides = {},
  policy?: NodeMemberTerminationPolicy
) {
  return new NodeMemberRuntime(
    {
      prepare: (_settings, attempt) => createSdkRuntimePlan(code, attempt, overrides),
      recover: rejectUnexpectedRecovery,
    },
    admit,
    policy
  );
}

function observations() {
  return {
    connected: vi.fn(),
    connectionLost: vi.fn(),
    failed: vi.fn<MemberRuntimeEvents['failed']>(),
    releaseFailed: vi.fn<MemberRuntimeEvents['releaseFailed']>(),
    released: vi.fn(),
    exited: vi.fn<MemberRuntimeEvents['exited']>(),
  };
}

async function settleWithin<T>(operation: Promise<T>): Promise<T> {
  const timeout = deferred<never>();
  const timer = setTimeout(() => timeout.reject(new Error('TEST stop did not settle')), 5000);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'TEST-input' } });
const releaseLine = JSON.stringify({
  type: 'control_request',
  request_id: 'release-line',
  request: { subtype: 'test-release' },
});

// Readiness is an SDK event plus a live authenticated socket, never diagnostic stdout.
describe('owned Node member process adapter', () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid termination deadlines %s before preparing a process',
    (deadline) => {
      const planner: NodeMemberLaunchPlanner = { prepare: vi.fn(), recover: vi.fn() };
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
      expect(planner.recover).not.toHaveBeenCalled();
    }
  );

  it("carries a dying member's real diagnostic stderr into the exit observation", async () => {
    const child = await runtime(
      "process.stderr.write('TEST-cause: no access\\n'); await finish(3);"
    ).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(
      () =>
        expect(events.exited).toHaveBeenCalledWith(
          expect.objectContaining({ code: 3, stderrTail: ['TEST-cause: no access'] })
        ),
      { timeout: 10_000 }
    );
    await child.stop();
  });

  it('replays real SDK readiness and terminal observations without inventing a live process', async () => {
    const child = await runtime('await ready(); await finish(7);').spawn(
      settings,
      token,
      new AbortController().signal
    );
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.exited).toHaveBeenCalledWith({ code: 7, signal: null }), {
      timeout: 10_000,
    });
    expect(events.connected).toHaveBeenCalledOnce();
    expect(child.identity.pid).toBeGreaterThan(0);
    expect(child.identity.birthId).toBeTruthy();
    await child.stop();
  });

  it('stops only the child it owns and preserves exactly one real terminal observation', async () => {
    const child = await runtime('await ready();').spawn(
      settings,
      token,
      new AbortController().signal
    );
    const events = observations();
    child.subscribe(events);
    await Promise.all([child.stop(), child.stop()]);
    expect(events.exited).toHaveBeenCalledOnce();
    expect(events.released).toHaveBeenCalledOnce();
  });

  it('waits for the newline completing an SDK event rather than accepting an unterminated tail', async () => {
    const fixture = await createNodeMemberRuntimeFixture();
    const partialPath = join(fixture.directory, 'partial-sent');
    const child = await new NodeMemberRuntime(
      {
        prepare: () =>
          fixture.plan(
            `
        ws.send(JSON.stringify({ type: 'system', subtype: 'team_bootstrap', team_name: token.teamName, run_id: token.runId, event: 'completed', status: 'completed', text: 'TEST-ready', uuid: 'partial-ready' }));
        ws.prependListener('message', bytes => { if (JSON.parse(bytes.toString()).request_id === 'release-line') ws.send('\\n'); });
        require('node:fs').writeFileSync(${JSON.stringify(partialPath)}, 'sent');
      `,
            token
          ),
        recover: rejectUnexpectedRecovery,
      },
      admit
    ).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(async () => expect(await readFile(partialPath, 'utf8')).toBe('sent'), {
      timeout: 10_000,
    });
    expect(events.connected).not.toHaveBeenCalled();
    await child.writeInput(releaseLine);
    await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await child.stop();
  });

  it('keeps UTF-8 bootstrap evidence intact across fragmented WebSocket frames', async () => {
    const child = await runtime(
      `
      const bytes = Buffer.from(JSON.stringify({ type: 'system', subtype: 'test-ready', text: 'Тест-готов', uuid: 'utf8-ready' }) + '\\n');
      const split = bytes.indexOf(Buffer.from('Т')) + 1;
      ws.send(bytes.subarray(0, split), { binary: false, fin: false });
      ws.send(bytes.subarray(split), { binary: false, fin: true });
    `,
      {
        observeOutput: (line) => (JSON.parse(line).text === 'Тест-готов' ? 'connected' : null),
      }
    ).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await child.stop();
  });

  it('binds a started child before bootstrap and releases resources only after its real exit', async () => {
    const disposed = vi.fn(async () => undefined);
    const bootstrapped = vi.fn<NonNullable<NodeMemberLaunchPlan['afterSpawn']>>(
      async () => undefined
    );
    const child = await runtime('await ready();', {
      afterSpawn: bootstrapped,
      dispose: disposed,
    }).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    expect(bootstrapped).toHaveBeenCalledWith(child.identity, expect.any(AbortSignal));
    await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(disposed).not.toHaveBeenCalled();
    await child.stop();
    expect(events.exited).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('rejects failed registration only after terminating its owned process and cleaning its artifacts', async () => {
    const disposed = vi.fn(async () => undefined);
    const register = vi.fn<NonNullable<NodeMemberLaunchPlan['afterSpawn']>>(async () => {
      throw new Error('TEST-registration-failed');
    });
    await expect(
      runtime('await ready();', { afterSpawn: register, dispose: disposed }).spawn(
        settings,
        token,
        new AbortController().signal
      )
    ).rejects.toThrow('TEST-registration-failed');
    expect(register).toHaveBeenCalledOnce();
    const identity = register.mock.calls[0]![0];
    expect((await inspectProcessByPid(identity.pid)).status).toBe('not_found');
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('delivers framed UUID input to its live SDK child exactly once and rejects input after stop', async () => {
    const fixture = await createNodeMemberRuntimeFixture();
    const child = await new NodeMemberRuntime(
      { prepare: () => fixture.plan('await ready();', token), recover: rejectUnexpectedRecovery },
      admit
    ).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await child.writeInput(userLine, 'TEST-command');
    await child.writeInput(userLine, 'TEST-command');
    expect(await fixture.commands(token)).toEqual([
      expect.objectContaining({ uuid: 'TEST-command', type: 'user' }),
    ]);
    await expect(child.writeInput(`${userLine}\n${userLine}`, 'TEST-injected')).rejects.toThrow();
    await child.stop();
    await expect(child.writeInput(userLine, 'TEST-late')).rejects.toThrow('no longer current');
  });

  it('retains attempt resources until pending registration settles after cancellation', async () => {
    const pending = deferred<void>();
    const disposed = vi.fn(async () => undefined);
    const registering = vi.fn<NonNullable<NodeMemberLaunchPlan['afterSpawn']>>(
      async () => pending.promise
    );
    const abort = new AbortController();
    const spawning = runtime('await ready();', {
      afterSpawn: registering,
      dispose: disposed,
    }).spawn(settings, token, abort.signal);
    const rejected = expect(spawning).rejects.toThrow();
    await vi.waitFor(() => expect(registering).toHaveBeenCalledOnce(), { timeout: 10_000 });
    abort.abort();
    expect(disposed).not.toHaveBeenCalled();
    pending.resolve();
    await rejected;
    expect((await inspectProcessByPid(registering.mock.calls[0]![0].pid)).status).toBe('not_found');
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('does not report release when cleanup fails after a real exit', async () => {
    const child = await runtime('await finish();', {
      dispose: async () => {
        throw new Error('TEST-cleanup-failed');
      },
    }).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.releaseFailed).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(events.exited).toHaveBeenCalledOnce();
    expect(events.released).not.toHaveBeenCalled();
    await expect(child.stop()).rejects.toThrow('TEST-cleanup-failed');
  });

  it('retries exact failed cleanup without respawning or announcing release more than once', async () => {
    let blocked = true;
    const dispose = vi.fn(async () => {
      if (blocked) throw new Error('TEST transient owned cleanup');
    });
    const child = await runtime('await finish();', { dispose }).spawn(
      settings,
      token,
      new AbortController().signal
    );
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.releaseFailed).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(events.released).not.toHaveBeenCalled();
    await expect(child.stop()).rejects.toThrow('TEST transient owned cleanup');
    blocked = false;
    const before = dispose.mock.calls.length;
    await Promise.all([child.stop(), child.stop()]);
    expect(dispose.mock.calls.length).toBe(before + 1);
    expect(events.released).toHaveBeenCalledOnce();
    await child.stop();
    expect(dispose.mock.calls.length).toBe(before + 1);
  });

  it('never interprets oversized diagnostic stdout or its tail as SDK readiness', async () => {
    const child = await runtime(
      "process.stdout.write('x'.repeat(1100000) + 'TEST-ready\\n'); await finish();"
    ).spawn(settings, token, new AbortController().signal);
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.exited).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(events.connected).not.toHaveBeenCalled();
    await child.stop();
  });

  it('rejects stale desktop admission after preparation and before creating an OS process', async () => {
    const owner = new BoundControlContext('TEST-app', 'TEST-root');
    const attempt = { ...token, ...owner.snapshot() };
    const disposed = vi.fn(async () => undefined);
    const admission = vi.fn();
    const adapter = new NodeMemberRuntime(
      {
        async prepare() {
          const plan = await createSdkRuntimePlan("throw new Error('must not run')", attempt, {
            dispose: disposed,
          });
          owner.transportReplaced();
          return plan;
        },
        recover: rejectUnexpectedRecovery,
      },
      async (expected, operation) => {
        admission(expected);
        const release = owner.admit(expected);
        try {
          return await operation();
        } finally {
          release();
        }
      }
    );
    await expect(
      adapter.spawn({ ...settings, team: attempt }, attempt, new AbortController().signal)
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(disposed).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledOnce();
  });

  it('fails and terminates its owned child when a socket opens without bootstrap evidence', async () => {
    const child = await runtime('', { connectionTimeoutMs: 1000 }).spawn(
      settings,
      token,
      new AbortController().signal
    );
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(
      () =>
        expect(events.failed).toHaveBeenCalledWith(
          'Owned runtime did not confirm bootstrap before the launch deadline'
        ),
      { timeout: 10_000 }
    );
    await vi.waitFor(() => expect(events.exited).toHaveBeenCalledOnce(), { timeout: 10_000 });
    expect(events.connected).not.toHaveBeenCalled();
    await expect(child.stop()).rejects.toThrow('bootstrap');
  });

  it('clears the deadline only after exact SDK readiness and an authenticated socket', async () => {
    // Real Windows PID/birth authority probes must finish inside this budget;
    // a one-second budget times out PowerShell rather than missing readiness.
    const child = await runtime('await ready();', { connectionTimeoutMs: 20_000 }).spawn(
      settings,
      token,
      new AbortController().signal
    );
    const events = observations();
    child.subscribe(events);
    await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 20_000 });
    // Fake time would also advance live OS-probe/socket deadlines; this integration
    // case deliberately waits past the actual runtime timer on the platform clock.
    await new Promise<void>((resolve) => setTimeout(resolve, 20_100));
    expect(events.failed).not.toHaveBeenCalled();
    await child.stop();
  }, 60_000);

  it.each(['stop', 'connection failure'] as const)(
    'escalates %s only for its exact owned child and waits for exit and cleanup',
    async (reason) => {
      const order: string[] = [];
      const proofFailure = deferred<(error: Error) => void>();
      const disposed = vi.fn(async () => {
        order.push('cleanup');
      });
      const child = await runtime(
        'await ready();',
        {
          dispose: disposed,
          connection: {
            subscribe(_identity, events) {
              proofFailure.resolve(events.failed);
              return () => undefined;
            },
          },
        },
        { gracePeriodMs: 25, forceExitTimeoutMs: 2000 }
      ).spawn(settings, token, new AbortController().signal);
      const other = await runtime('await ready();').spawn(
        settings,
        { ...token, operationId: 'TEST-other' },
        new AbortController().signal
      );
      const events = observations();
      const otherEvents = observations();
      child.subscribe({
        ...events,
        exited: (exit) => {
          events.exited(exit);
          order.push('exit');
        },
        released: () => {
          events.released();
          order.push('released');
        },
      });
      other.subscribe(otherEvents);
      const kill = ChildProcess.prototype.kill;
      const signals: (NodeJS.Signals | number | undefined)[] = [];
      // Windows cannot ignore SIGTERM: withhold only this child's first signal, then use its real handle.
      const controlled = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
        this: ChildProcess,
        signal
      ) {
        if (this.pid !== child.identity.pid) return kill.call(this, signal);
        signals.push(signal);
        return signal === undefined || signal === 'SIGTERM' ? true : kill.call(this, signal);
      });
      try {
        await vi.waitFor(
          () => {
            expect(events.connected).toHaveBeenCalledOnce();
            expect(otherEvents.connected).toHaveBeenCalledOnce();
          },
          { timeout: 10_000 }
        );
        if (reason === 'connection failure')
          (await proofFailure.promise)(new Error('TEST connection failed'));
        const stopping = child.stop();
        expect(child.stop()).toBe(stopping);
        if (reason === 'connection failure')
          await expect(settleWithin(stopping)).rejects.toThrow('TEST connection failed');
        else await settleWithin(stopping);
        expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(order).toEqual(['exit', 'cleanup', 'released']);
        expect(disposed).toHaveBeenCalledOnce();
        expect(otherEvents.exited).not.toHaveBeenCalled();
      } finally {
        controlled.mockRestore();
        await Promise.all([child.stop().catch(() => undefined), other.stop()]);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'terminates a real POSIX child that ignores SIGTERM through its owned handle',
    async () => {
      const child = await runtime(
        "process.on('SIGTERM', () => {}); await ready();",
        {},
        { gracePeriodMs: 25, forceExitTimeoutMs: 2000 }
      ).spawn(settings, token, new AbortController().signal);
      const events = observations();
      child.subscribe(events);
      await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), { timeout: 10_000 });
      await settleWithin(child.stop());
      expect(events.exited).toHaveBeenCalledWith({ code: null, signal: 'SIGKILL' });
    }
  );

  it.each([true, false])(
    'retains exact ownership after signal result %s until a real OS exit',
    async (signalAccepted) => {
      const disposed = vi.fn(async () => undefined);
      const child = await runtime(
        'await ready();',
        { dispose: disposed },
        { gracePeriodMs: 25, forceExitTimeoutMs: 25 }
      ).spawn(settings, token, new AbortController().signal);
      const identity = child.identity;
      const events = observations();
      child.subscribe(events);
      const kill = ChildProcess.prototype.kill;
      let forceOwnedExit: (() => void) | undefined;
      const controlled = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
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
        await vi.waitFor(() => expect(events.connected).toHaveBeenCalledOnce(), {
          timeout: 10_000,
        });
        await expect(settleWithin(child.stop())).rejects.toThrow('termination deadline');
        expect(events.failed).toHaveBeenCalledWith(expect.stringContaining('termination deadline'));
        expect(events.exited).not.toHaveBeenCalled();
        expect(disposed).not.toHaveBeenCalled();
        expect(events.released).not.toHaveBeenCalled();
        expect(child.identity).toBe(identity);
        await expect(settleWithin(child.stop())).rejects.toThrow('termination deadline');
      } finally {
        controlled.mockRestore();
        forceOwnedExit?.();
        await child.stop().catch(() => undefined);
      }
      expect(events.exited).toHaveBeenCalledOnce();
      expect(disposed).toHaveBeenCalledOnce();
      expect(events.released).toHaveBeenCalledOnce();
    }
  );

  it('does not start a process after cancellation', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      runtime("throw new Error('must not run')").spawn(settings, token, abort.signal)
    ).rejects.toThrow();
  });

  it('reconnects the same real child after host/SQLite replacement without replaying accepted work or launching again', async () => {
    const fixture = await createNodeMemberRuntimeFixture();
    const startsPath = join(fixture.directory, 'starts.txt');
    const prepare = vi.fn(() =>
      fixture.plan(
        `require('node:fs').appendFileSync(${JSON.stringify(startsPath)}, 'started\\n'); await ready();`,
        token
      )
    );
    const recover = vi.fn<NodeMemberLaunchPlanner['recover']>((_settings, attempt) =>
      fixture.recover(attempt)
    );
    const first = await new NodeMemberRuntime({ prepare, recover }, admit).spawn(
      settings,
      token,
      new AbortController().signal
    );
    const firstEvents = observations();
    const unsubscribe = first.subscribe(firstEvents);
    await vi.waitFor(() => expect(firstEvents.connected).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    await first.writeInput(userLine, 'accepted-before-restart');
    const inspection = await inspectProcessByPid(first.identity.pid);
    if (inspection.status !== 'found' || inspection.startedAt === undefined)
      throw new Error('Owned child birth unavailable');
    unsubscribe();
    await fixture.replaceHost();
    const recovered = await new NodeMemberRuntime({ prepare, recover }, admit).reconnect(
      settings,
      token,
      first.identity,
      inspection.startedAt,
      new AbortController().signal
    );
    const recoveredEvents = observations();
    recovered.subscribe(recoveredEvents);
    await vi.waitFor(() => expect(recoveredEvents.connected).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    expect(recovered.identity).toEqual(first.identity);
    expect(prepare).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    await recovered.writeInput(userLine, 'accepted-before-restart');
    await recovered.writeInput(userLine, 'accepted-after-restart');
    expect((await fixture.commands(token)).map((event) => event.uuid)).toEqual([
      'accepted-before-restart',
      'accepted-after-restart',
    ]);
    expect(await readFile(startsPath, 'utf8')).toBe('started\n');
    await recovered.stop();
    expect(recoveredEvents.exited).toHaveBeenCalledOnce();
    expect(recoveredEvents.released).toHaveBeenCalledOnce();
  }, 20_000);

  it('refuses stale process birth before invoking recovery or creating a replacement process', async () => {
    const fixture = await createNodeMemberRuntimeFixture();
    const prepare = vi.fn(() => fixture.plan('await ready();', token));
    const recover = vi.fn<NodeMemberLaunchPlanner['recover']>((_settings, attempt) =>
      fixture.recover(attempt)
    );
    const adapter = new NodeMemberRuntime({ prepare, recover }, admit);
    const child = await adapter.spawn(settings, token, new AbortController().signal);
    const inspection = await inspectProcessByPid(child.identity.pid);
    if (inspection.status !== 'found' || inspection.startedAt === undefined)
      throw new Error('Owned child birth unavailable');
    await expect(
      adapter.reconnect(
        settings,
        token,
        child.identity,
        inspection.startedAt + 1,
        new AbortController().signal
      )
    ).rejects.toThrow('birth is not current');
    expect(recover).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    await child.stop();
  });
});
