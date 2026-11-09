import { describe, expect, it, vi } from 'vitest';

import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { NativeStartupWorkDelivery } from '../../../../src/features/team-provisioning/main/adapters/output/NativeStartupWorkDelivery';

import type { AppConnectionContext } from '../../../../src/features/external-agent-connection/contracts';
import type { MemberProcessToken, TeamRunIdentity } from '../../../../src/features/team-provisioning/contracts';
import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type { TeamTask } from '../../../../src/shared/types';

const owner: AppConnectionContext = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run: TeamRunIdentity = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };
const memberName = 'builder';
const task: TeamTask = { id: '1', subject: 'TEST task', status: 'pending', owner: memberName };


function deferredTasks(): { promise: Promise<TeamTask[]>; resolve: (tasks: TeamTask[]) => void } {
  let resolve!: (tasks: TeamTask[]) => void;
  const promise = new Promise<TeamTask[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function launchFor(identity: TeamRunIdentity): ConfiguredMemberLaunch {
  return {
    team: identity,
    memberName,
    configurationRevision: 'TEST-revision',
    providerId: 'anthropic',
    model: null,
    role: 'member',
    workingDirectory: 'C:/TEST/workspace',
    instructions: 'TEST',
  };
}

function startMember(
  registry: MemberLifecycleRegistry,
  identity: TeamRunIdentity,
  operationId: string
): { token: Readonly<MemberProcessToken>; process: { pid: number; birthId: string } } {
  const admission = registry.beginStart(identity, memberName, operationId);
  if (admission.kind !== 'launch') throw new Error('Expected member launch admission');
  const process = { pid: 123, birthId: operationId };
  registry.observeSpawn(admission.token, process);
  registry.observeConnected(admission.token);
  return { token: admission.token, process };
}

function setup(options: {
  contextInvalidationSignal?: () => AbortSignal;
  readTasks?: (teamName: string) => Promise<TeamTask[]>;
  withExpectedContext?: <T>(
    expected: AppConnectionContext,
    operation: () => Promise<T>
  ) => Promise<T>;
  deliver?: (
    member: string,
    settings: { launchId: string; isCurrent: () => boolean }
  ) => Promise<{
    delivered: readonly unknown[];
    skipped: readonly unknown[];
  }>;
} = {}) {
  const registry = new MemberLifecycleRegistry(owner);
  registry.configureTeam(run, [{ memberName, role: 'member' }]);
  const readTasks = vi.fn(options.readTasks ?? (async () => [task]));
  const deliver = vi.fn(
    options.deliver ?? (async () => ({ delivered: [task], skipped: [] }))
  );
  const createController = vi.fn((_input: { readOnlyTaskSnapshot: TeamTask[] }) => ({
    taskBoard: { deliverStartupWorkAsync: deliver },
  }));
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  const delivery = new NativeStartupWorkDelivery({
    registry,
    contextInvalidationSignal:
      options.contextInvalidationSignal ?? (() => new AbortController().signal),
    withExpectedContext:
      options.withExpectedContext ?? (async (_expected, operation) => operation()),
    createController,
    readTasks,
    getClaudeBasePath: () => 'C:/TEST/claude',
    appendDiagnostic: (_identity, _member, text) => diagnostics.push(text),
    logger: { warn: (message) => warnings.push(message) },
  });
  return { registry, delivery, readTasks, deliver, createController, diagnostics, warnings };
}

describe('native startup work delivery', () => {
  it('delivers once after confirmation and shares an in-flight confirmation', async () => {
    const { promise: firstRead, resolve: finishRead } = deferredTasks();
    const h = setup({ readTasks: () => firstRead });
    const { token } = startMember(h.registry, run, 'TEST-operation-1');
    const launch = launchFor(run);

    const first = h.delivery.confirmed(launch, token);
    const repeated = h.delivery.confirmed(launch, token);
    expect(repeated).toBe(first);
    expect(h.readTasks).toHaveBeenCalledTimes(1);
    finishRead([task]);
    await first;

    await h.delivery.confirmed(launch, token);
    expect(h.readTasks).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.createController).toHaveBeenCalledWith({
      teamName: run.teamName,
      claudeDir: 'C:/TEST/claude',
      readOnlyTaskSnapshot: [task],
    });
  });

  it('does not read or deliver until the registry confirms the current member generation', async () => {
    const h = setup();
    const admission = h.registry.beginStart(run, memberName, 'TEST-operation-1');
    if (admission.kind !== 'launch') throw new Error('Expected member launch admission');

    await h.delivery.confirmed(launchFor(run), admission.token);

    expect(h.readTasks).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('retries a transient registry read failure after one confirmed connection event', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const h = setup({
        readTasks: async () => {
          reads += 1;
          if (reads === 1) throw new Error('TEST registry unavailable');
          return [task];
        },
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      expect(reads).toBe(1);
      expect(h.warnings).toHaveLength(1);
      expect(h.diagnostics.some((entry) => entry.includes('TEST registry unavailable'))).toBe(true);
      expect(h.createController).not.toHaveBeenCalled();
      expect(h.deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(reads).toBe(2);
      expect(h.deliver).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retries when the run is released', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const h = setup({
        readTasks: async () => {
          reads += 1;
          throw new Error('TEST registry unavailable');
        },
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      h.delivery.release(run);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(reads).toBe(1);
      expect(h.deliver).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retries when app context invalidates the launch', async () => {
    vi.useFakeTimers();
    try {
      const context = new AbortController();
      let reads = 0;
      const h = setup({
        contextInvalidationSignal: () => context.signal,
        readTasks: async () => {
          reads += 1;
          throw new Error('TEST registry unavailable');
        },
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      context.abort();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a no-item handover without retrying', async () => {
    vi.useFakeTimers();
    try {
      const h = setup({ deliver: async () => ({ delivered: [], skipped: [] }) });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      await vi.advanceTimersByTimeAsync(60_000);
      await h.delivery.confirmed(launchFor(run), token);

      expect(h.readTasks).toHaveBeenCalledTimes(1);
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(h.diagnostics.some((entry) => entry.includes('0 task message(s) delivered'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes normally when every startup notice is skipped', async () => {
    vi.useFakeTimers();
    try {
      const h = setup({
        deliver: async () => ({ delivered: [], skipped: ['TEST-existing-notice'] }),
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      await vi.advanceTimersByTimeAsync(60_000);
      await h.delivery.confirmed(launchFor(run), token);

      expect(h.readTasks).toHaveBeenCalledTimes(1);
      expect(h.deliver).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues through many failures until registry recovery', async () => {
    vi.useFakeTimers();
    try {
      const delays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000] as const;
      let reads = 0;
      const h = setup({
        readTasks: async () => {
          reads += 1;
          if (reads <= delays.length) throw new Error('TEST registry unavailable');
          return [task];
        },
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      expect(reads).toBe(1);
      for (const delay of delays) await vi.advanceTimersByTimeAsync(delay);

      expect(reads).toBe(9);
      expect(h.deliver).toHaveBeenCalledTimes(1);
      expect(h.diagnostics.some((entry) => entry.includes('1 task message(s) delivered'))).toBe(
        true
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a task snapshot if the member generation stops while the registry read is pending', async () => {
    const { promise: firstRead, resolve: finishRead } = deferredTasks();
    const h = setup({ readTasks: () => firstRead });
    const { token, process } = startMember(h.registry, run, 'TEST-operation-1');

    const pending = h.delivery.confirmed(launchFor(run), token);
    h.registry.observeExit(token, process, { code: 0, signal: null });
    finishRead([task]);
    await pending;

    expect(h.createController).not.toHaveBeenCalled();
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('does not begin a registry read when app-context admission fails', async () => {
    const h = setup({
      withExpectedContext: async () => {
        throw new Error('TEST app context mismatch');
      },
    });
    const { token } = startMember(h.registry, run, 'TEST-operation-1');

    await h.delivery.confirmed(launchFor(run), token);

    expect(h.readTasks).not.toHaveBeenCalled();
    expect(h.warnings.some((entry) => entry.includes('TEST app context mismatch'))).toBe(true);
    expect(h.diagnostics.some((entry) => entry.includes('TEST app context mismatch'))).toBe(true);
    h.delivery.release(run);
  });

  it('retries a synchronous app-context admission throw without escaping the connection callback', async () => {
    vi.useFakeTimers();
    try {
      let admissions = 0;
      const h = setup({
        withExpectedContext: (_expected, operation) => {
          admissions += 1;
          if (admissions === 1) throw new Error('TEST synchronous context mismatch');
          return operation();
        },
      });
      const { token } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      expect(h.warnings.some((entry) => entry.includes('TEST synchronous context mismatch'))).toBe(
        true
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(admissions).toBe(2);
      expect(h.deliver).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled retry when the member generation stops', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const h = setup({
        readTasks: async () => {
          reads += 1;
          throw new Error('TEST registry unavailable');
        },
      });
      const { token, process } = startMember(h.registry, run, 'TEST-operation-1');

      await h.delivery.confirmed(launchFor(run), token);
      h.registry.requestStop(run, memberName);
      h.registry.observeExit(token, process, { code: 0, signal: null });
      h.registry.observeMemberReleased(token);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(reads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences a previous generation after the same member restarts', async () => {
    const h = setup();
    const previous = startMember(h.registry, run, 'TEST-operation-1');
    h.registry.requestStop(run, memberName);
    h.registry.observeExit(previous.token, previous.process, { code: 0, signal: null });
    h.registry.observeMemberReleased(previous.token);
    const current = startMember(h.registry, run, 'TEST-operation-2');

    await h.delivery.confirmed(launchFor(run), previous.token);
    expect(h.readTasks).not.toHaveBeenCalled();
    await h.delivery.confirmed(launchFor(run), current.token);
    expect(h.readTasks).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
    await h.delivery.confirmed(launchFor(run), previous.token);
    expect(h.readTasks).toHaveBeenCalledTimes(1);
    expect(h.deliver).toHaveBeenCalledTimes(1);
  });
});
