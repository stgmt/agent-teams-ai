// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeOpenCodePromptDeliverySupervisor } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliverySupervisor';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';
import type { NativeOpenCodePromptDeliverySupervisorDependencies } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliverySupervisor';

function lane(runtimeAlive: boolean) {
  return {
    laneId: 'lane-1',
    sessionId: 'session-1',
    hostPid: 42,
    runtimeAlive,
    bootstrapConfirmed: true,
    permissionBlocked: false,
  } as unknown as NonNullable<TeamLifecycleSnapshot['members'][string]['lane']>;
}

function snapshot(
  state: TeamLifecycleSnapshot['state'],
  members: TeamLifecycleSnapshot['members']
) {
  return {
    identity: { teamName: 'alpha', runId: 'run-alpha' },
    desired: 'running',
    state,
    members,
  } as unknown as TeamLifecycleSnapshot;
}

function supervisor(options: {
  runs?: Record<string, TeamLifecycleSnapshot>;
  relay?: ReturnType<typeof vi.fn>;
  readInboxMessages?: ReturnType<typeof vi.fn>;
  ledgers?: NativeOpenCodePromptDeliverySupervisorDependencies['ledgers'];
  status?: (teamName: string, messageId: string) => Promise<unknown>;
}) {
  const relay = options.relay ?? vi.fn(async () => ({ relayed: 1, attempted: 1, delivered: 1, failed: 0 }));
  const runs = options.runs ?? {};
  return {
    relay,
    subject: new NativeOpenCodePromptDeliverySupervisor({
      runs: {
        find: (teamName: string) => runs[teamName] ?? null,
        isLive: (run: { teamName?: string; identity?: { teamName?: string } }) => {
          const team = run.identity?.teamName ?? run.teamName ?? '';
          const snapshot = runs[team];
          return Boolean(snapshot) && snapshot.desired !== 'stopped';
        },
        aliveTeamNames: () => Object.keys(runs),
      },
      delivery: {
        relayOpenCodeMemberInboxMessages: relay as never,
      },
      ...(options.status
        ? { observeDelivery: options.status as never }
        : {}),
      readInboxMessages:
        options.readInboxMessages ?? vi.fn(async () => [{ messageId: 'message-1', read: false }]),
      ...(options.ledgers ? { ledgers: options.ledgers } : {}),
      info: () => {},
      warn: () => {},
      debug: () => {},
      diagnostic: () => {},
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    }),
  };
}

const liveRun = snapshot('ready', {
  builder: { memberName: 'builder', role: 'member', lane: lane(true) } as unknown as TeamLifecycleSnapshot['members'][string],
});

describe('native OpenCode prompt delivery supervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG;
  });

  it('relays a due wake for a member whose lane is alive', async () => {
    const { relay, subject } = supervisor({ runs: { alpha: liveRun } });
    subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-1',
    });

    await vi.advanceTimersByTimeAsync(3_200);

    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0]).toEqual([
      'alpha',
      'builder',
      { onlyMessageId: 'message-1', source: 'watchdog' },
    ]);

    // A guarded schedule forwards its guard, so a walk cannot outlive the
    // generation that armed it.
    const guarded = supervisor({ runs: { alpha: liveRun } });
    const isCurrent = () => true;
    guarded.subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-2',
      isCurrent,
    });
    await vi.advanceTimersByTimeAsync(3_200);

    expect(guarded.relay.mock.calls[0]?.[2]).toMatchObject({ onlyMessageId: 'message-2', isCurrent });
  });

  it('still relays when a lane observation is stale but the run is live', async () => {
    const deadRun = snapshot('ready', {
      builder: {
        memberName: 'builder',
        role: 'member',
        lane: lane(false),
      } as unknown as TeamLifecycleSnapshot['members'][string],
    });
    const { relay, subject } = supervisor({ runs: { alpha: deadRun } });
    subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-1',
    });

    await vi.advanceTimersByTimeAsync(3_200);

    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('does not relay a wake that a newer generation revoked', async () => {
    const { relay, subject } = supervisor({ runs: { alpha: liveRun } });
    subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-1',
      isCurrent: () => false,
    });

    await vi.advanceTimersByTimeAsync(3_200);

    expect(relay).not.toHaveBeenCalled();
  });

  it('drops every armed wake of a team that is detached', async () => {
    const { relay, subject } = supervisor({ runs: { alpha: liveRun } });
    subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-1',
    });
    subject.cancelTeam('alpha');

    await vi.advanceTimersByTimeAsync(3_200);

    expect(relay).not.toHaveBeenCalled();
  });

  it('arms a wake for a due record a previous session left behind', async () => {
    const record = (inboxMessageId: string, overrides: Record<string, unknown> = {}) => ({
      inboxMessageId,
      memberName: 'builder',
      runId: 'run-alpha',
      laneId: 'primary',
      status: 'retry_scheduled',
      responseState: 'not_observed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
    const listDue = vi.fn(async () => [
      record('due-row'),
      record('other-run-row', { runId: 'run-previous' }),
      record('cancelled-row', { cancelledAt: '2026-01-01T00:00:00.000Z' }),
      record('accepted-row', {
        status: 'accepted',
        responseState: 'pending',
        runtimePromptMessageId: 'runtime-prompt-1',
        lastRuntimePromptMessageId: 'runtime-prompt-1',
      }),
      record('unknown-acceptance-row', { acceptanceUnknown: true }),
      record('repair-handoff-row', { groupRepairHandoffPending: true }),
    ]);
    const { relay, subject } = supervisor({
      runs: { alpha: liveRun },
      ledgers: { open: () => ({ listDue }) } as never,
    });

    // One row is safe to re-prompt. A row from an earlier run, a cancelled row,
    // an accepted-but-unfinished row and an acceptance-unknown row are not.
    await expect(subject.sweepDueDeliveries()).resolves.toBe(1);
    expect(listDue).toHaveBeenCalledWith({
      teamName: 'alpha',
      now: expect.any(Date),
      limit: expect.any(Number),
    });

    await vi.advanceTimersByTimeAsync(3_200);
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0]?.slice(0, 2)).toEqual(['alpha', 'builder']);
    expect(relay.mock.calls[0]?.[2]).toMatchObject({ onlyMessageId: 'due-row' });
  });

  it('observes a row instead of re-prompting when a turn is still in flight', async () => {
    const record = {
      inboxMessageId: 'pending-row',
      memberName: 'builder',
      runId: 'run-alpha',
      laneId: 'primary',
      status: 'retry_scheduled',
      responseState: 'not_observed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    };
    const { relay, subject } = supervisor({
      runs: { alpha: liveRun },
      ledgers: {
        open: () => ({ listDue: vi.fn(async () => [record]), markNextAttemptDeferred: vi.fn() }),
      } as never,
      status: async () => ({ responsePending: true, ledgerStatus: 'accepted' }),
    });

    await expect(subject.sweepDueDeliveries()).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(3_200);
    expect(relay).not.toHaveBeenCalled();
  });

  it('re-prompts a row the runtime never answered', async () => {
    const record = {
      inboxMessageId: 'unanswered-row',
      memberName: 'builder',
      runId: 'run-alpha',
      laneId: 'primary',
      status: 'failed_retryable',
      responseState: 'not_observed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    };
    const { relay, subject } = supervisor({
      runs: { alpha: liveRun },
      ledgers: {
        open: () => ({ listDue: vi.fn(async () => [record]), markNextAttemptDeferred: vi.fn() }),
      } as never,
      status: async () => ({ responseState: 'not_observed', ledgerStatus: 'failed_retryable' }),
    });

    await expect(subject.sweepDueDeliveries()).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(3_200);
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it('never re-prompts a row whose reply already arrived', async () => {
    const record = {
      inboxMessageId: 'answered-row',
      memberName: 'builder',
      runId: 'run-alpha',
      laneId: 'primary',
      status: 'retry_scheduled',
      responseState: 'not_observed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    };
    const { relay, subject } = supervisor({
      runs: { alpha: liveRun },
      ledgers: {
        open: () => ({ listDue: vi.fn(async () => [record]), markNextAttemptDeferred: vi.fn() }),
      } as never,
      status: async () => ({ responseState: 'responded_visible_message' }),
    });

    await expect(subject.sweepDueDeliveries()).resolves.toBe(0);
    await vi.advanceTimersByTimeAsync(3_200);
    expect(relay).not.toHaveBeenCalled();
  });

  it('moves an observed row out of the due set without touching its verdict', async () => {
    const record = {
      id: 'row-1',
      inboxMessageId: 'pending-row',
      memberName: 'builder',
      runId: 'run-alpha',
      laneId: 'primary',
      status: 'retry_scheduled',
      attempts: 2,
      responseState: 'not_observed',
      nextAttemptAt: '2026-01-01T00:00:00.000Z',
    };
    const markNextAttemptDeferred = vi.fn(async () => record);
    const { relay, subject } = supervisor({
      runs: { alpha: liveRun },
      ledgers: {
        open: () => ({ listDue: vi.fn(async () => [record]), markNextAttemptDeferred }),
      } as never,
      status: async () => ({ responsePending: true }),
    });

    await expect(subject.sweepDueDeliveries()).resolves.toBe(0);
    expect(markNextAttemptDeferred).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'row-1' })
    );
    await vi.advanceTimersByTimeAsync(3_200);
    expect(relay).not.toHaveBeenCalled();
  });

  it('skips a team whose run is no longer live', async () => {
    const listDue = vi.fn(async () => []);
    const stopped = { ...liveRun, desired: 'stopped' } as unknown as TeamLifecycleSnapshot;
    const { subject } = supervisor({
      runs: { alpha: stopped },
      ledgers: { open: () => ({ listDue }) } as never,
    });

    await expect(subject.sweepDueDeliveries()).resolves.toBe(0);
    expect(listDue).not.toHaveBeenCalled();
  });

  it('stays off when the retained watchdog switch is off', async () => {
    process.env.CLAUDE_TEAM_OPENCODE_PROMPT_DELIVERY_WATCHDOG = '0';
    const { relay, subject } = supervisor({ runs: { alpha: liveRun } });
    expect(subject.isEnabled()).toBe(false);

    subject.scheduleDeliveryVerification({
      teamName: 'alpha',
      memberName: 'builder',
      messageId: 'message-1',
    });
    await vi.advanceTimersByTimeAsync(3_200);

    expect(relay).not.toHaveBeenCalled();
  });
});
