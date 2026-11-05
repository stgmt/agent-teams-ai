// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeLeadRestartAssessment } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadRestartAssessment';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const identity = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

function snapshot(): TeamLifecycleSnapshot {
  return {
    identity,
    members: {
      'team-lead': { memberName: 'team-lead', role: 'lead' },
      builder: { memberName: 'builder', role: 'member' },
    },
  } as unknown as TeamLifecycleSnapshot;
}

function setup(
  options: {
    live?: boolean;
    present?: boolean;
    activity?: 'idle' | 'active';
    activeToolCalls?: readonly string[];
    sessionId?: string | null;
    approvals?: number;
    configuredProvider?: string | null;
  } = {}
) {
  const {
    live = true,
    present = true,
    activity = 'idle',
    activeToolCalls = [],
    sessionId = 'sess-1',
    approvals = 0,
    configuredProvider = 'anthropic',
  } = options;
  const assessment = new NativeLeadRestartAssessment({
    runs: {
      find: (teamName) => (present && teamName === identity.teamName ? snapshot() : null),
      isLive: () => live,
    },
    settings: {
      findConfiguredMember: vi.fn(async () =>
        configuredProvider === null
          ? null
          : { providerId: configuredProvider, memberName: 'team-lead' }
      ),
    } as never,
    leadOutput: {
      facts: () => ({ detectedSessionId: sessionId, activity, activeToolCalls, lastActivityAt: null }),
      detectedSessionId: () => sessionId,
    },
    approvals: { list: () => new Array(approvals).fill({}) as never },
  });
  return assessment;
}

const settings = { providerId: 'anthropic' as const, model: null, effort: null };

describe('NativeLeadRestartAssessment', () => {
  it('admits a restart only when the lead is idle, approved-clear, and has a detected session', async () => {
    await expect(setup().assess(identity.teamName, settings)).resolves.toEqual({
      outcome: 'ready',
      runId: identity.runId,
    });
  });

  it('reports busy while the lead turn, a tool call, or an approval is still open', async () => {
    await expect(setup({ activity: 'active' }).assess(identity.teamName, settings)).resolves.toEqual(
      { outcome: 'busy', reason: 'Lead has an active turn, tool call, or approval' }
    );
    await expect(
      setup({ activeToolCalls: ['Read'] }).assess(identity.teamName, settings)
    ).resolves.toMatchObject({ outcome: 'busy' });
    await expect(setup({ approvals: 1 }).assess(identity.teamName, settings)).resolves.toMatchObject(
      { outcome: 'busy' }
    );
  });

  it('requires a relaunch when the run is gone, not live, or has no resume proof', async () => {
    await expect(
      setup({ present: false }).assess(identity.teamName, settings)
    ).resolves.toMatchObject({ outcome: 'relaunch_required' });
    await expect(setup({ live: false }).assess(identity.teamName, settings)).resolves.toMatchObject({
      outcome: 'relaunch_required',
    });
    await expect(
      setup({ sessionId: null }).assess(identity.teamName, settings)
    ).resolves.toEqual({
      outcome: 'relaunch_required',
      reason: 'Lead resume ownership is unproven',
    });
  });

  it('refuses when the configured lead provider no longer matches the requested one', async () => {
    await expect(
      setup({ configuredProvider: 'codex' }).assess(identity.teamName, settings)
    ).resolves.toEqual({
      outcome: 'relaunch_required',
      reason: 'Lead provider ownership changed',
    });
    await expect(
      setup({ configuredProvider: null }).assess(identity.teamName, settings)
    ).resolves.toMatchObject({ outcome: 'relaunch_required' });
  });

  it('never admits a restart in the middle of a running turn', async () => {
    const assessment = setup({ activity: 'active' });
    const result = await assessment.assess(identity.teamName, settings);
    expect(result.outcome).not.toBe('ready');
  });
});
