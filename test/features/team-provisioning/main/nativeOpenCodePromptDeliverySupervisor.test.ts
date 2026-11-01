// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeOpenCodePromptDeliverySupervisor } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliverySupervisor';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

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
  return { identity: { teamName: 'alpha' }, state, members } as unknown as TeamLifecycleSnapshot;
}

function supervisor(options: {
  runs?: Record<string, TeamLifecycleSnapshot>;
  relay?: ReturnType<typeof vi.fn>;
  readInboxMessages?: ReturnType<typeof vi.fn>;
}) {
  const relay = options.relay ?? vi.fn(async () => ({ relayed: 1, attempted: 1, delivered: 1, failed: 0 }));
  const runs = options.runs ?? {};
  return {
    relay,
    subject: new NativeOpenCodePromptDeliverySupervisor({
      runs: {
        find: (teamName: string) => runs[teamName] ?? null,
        isLive: (run: { teamName?: string; identity?: { teamName?: string } }) =>
          Boolean(runs[run.identity?.teamName ?? run.teamName ?? '']),
      },
      delivery: {
        relayOpenCodeMemberInboxMessages: relay as never,
      },
      readInboxMessages:
        options.readInboxMessages ?? vi.fn(async () => [{ messageId: 'message-1', read: false }]),
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
