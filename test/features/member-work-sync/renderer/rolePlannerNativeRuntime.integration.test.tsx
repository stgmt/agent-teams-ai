import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock(
  '@features/team-provisioning',
  () => import('@features/team-provisioning/core/domain/teamLifecycleState')
);
import { planRoleActivation } from '@features/member-work-sync/core/domain/RoleActivationPlan';
import {
  isPlannerSnapshotTrusted,
  projectRuntimeForRolePlan,
} from '@features/member-work-sync/renderer/rolePlannerRuntime';

import { toTeamAgentRuntimeSnapshot } from '../../../../src/main/team-runtime/nativeTeamRuntimeProjection';
import { stabilizeTeamAgentRuntimeSnapshot } from '../../../../src/renderer/store/team/teamAgentRuntimeSnapshotStabilizer';

import type {
  MemberLifecycleSnapshot,
  TeamLifecycleSnapshot,
} from '@features/team-provisioning/contracts';
import type { ResolvedTeamMember, TeamAgentRuntimeSnapshot } from '@shared/types';

const getTeamAgentRuntime = vi.hoisted(() => vi.fn());
vi.mock('@renderer/api', () => ({ api: { teams: { getTeamAgentRuntime } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));
import { RoleActivationPlanner } from '@features/member-work-sync/renderer/ui/RoleActivationPlanner';

function lifecycle(name: string, phase: MemberLifecycleSnapshot['phase']): MemberLifecycleSnapshot {
  return {
    memberName: name,
    role: name === 'team-lead' ? 'lead' : 'member',
    membership: 'configured',
    desired: 'running',
    phase,
    resources: 'held',
    generation: 1,
    operationId: `fixture-${name}`,
    process:
      phase === 'stopped' || phase === 'starting' || phase === 'exited'
        ? null
        : { pid: name === 'team-lead' ? 123 : 456, birthId: 'fixture' },
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: phase === 'failed' ? 'fixture failed' : null,
    exit: null,
  };
}
function nativeSnapshot(phase: MemberLifecycleSnapshot['phase']): TeamAgentRuntimeSnapshot {
  const now = new Date().toISOString();
  const source: TeamLifecycleSnapshot = {
    identity: {
      appInstanceId: 'fixture',
      dataRootFingerprint: 'fixture',
      connectionGeneration: 1,
      teamName: 'fixture-team',
      runId: 'fixture-run',
    },
    desired: 'running',
    resources: 'held',
    state: 'ready',
    error: null,
    version: 1,
    startedAt: now,
    members: { 'team-lead': lifecycle('team-lead', 'ready'), worker: lifecycle('worker', phase) },
  };
  return toTeamAgentRuntimeSnapshot(source, now);
}
function member(name: string, agentType?: string): ResolvedTeamMember {
  return {
    name,
    agentType,
    status: 'idle',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
  };
}
function props() {
  return {
    teamName: 'fixture-team',
    teamAlive: true,
    members: [member('team-lead', 'team-lead'), member('worker')],
    tasks: [{ id: '1', subject: 'Fixture', status: 'pending' as const, owner: 'worker' }],
    kanbanState: { teamName: 'fixture-team', reviewers: [], tasks: {} },
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getTeamAgentRuntime.mockReset();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
describe('isolated native/planner boundary', () => {
  it('plans a configured worker stopped by the native lifecycle while keeping a starting worker unknown', () => {
    const native = nativeSnapshot('stopped');
    const view = projectRuntimeForRolePlan(native, true);
    expect(view.stateFor('worker')).toBe('stopped');
    expect(projectRuntimeForRolePlan(nativeSnapshot('starting'), true).stateFor('worker')).toBe(
      'unknown'
    );
    const plan = planRoleActivation({
      teamName: 'fixture-team',
      teamAlive: true,
      runtimeSnapshotTrusted: true,
      runningRuntimeMembers: view.runningRuntimeMembers,
      leadRuntimeMembers: view.leadRuntimeMembers,
      runtimeOccupancyUncertain: view.runtimeOccupancyUncertain,
      maxConcurrentRoles: 3,
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          runtime: view.stateFor('team-lead'),
          availabilityBlocked: false,
          availabilityConfirmed: true,
        },
        {
          name: 'worker',
          runtime: view.stateFor('worker'),
          availabilityBlocked: false,
          availabilityConfirmed: true,
        },
      ],
      tasks: [{ id: '1', status: 'pending', owner: 'worker' }],
    });
    expect(plan.rows[0]).toMatchObject({ decision: 'recommend', usesExistingSlot: false });
  });
  it('withdraws a recommendation when an authoritative native stop passes through the store stabilizer', async () => {
    const before = nativeSnapshot('ready');
    const stopped = nativeSnapshot('stopped');
    const visible = stabilizeTeamAgentRuntimeSnapshot(before, stopped, Date.now() + 5_000);
    getTeamAgentRuntime.mockResolvedValue(before);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<RoleActivationPlanner {...props()} currentRuntime={before} />)
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="rolePlanner.title"]')?.click();
    });
    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].click();
    });
    expect(host.textContent).toContain('rolePlanner.recommended');
    expect(visible.members.worker.alive).toBe(false);
    await act(async () =>
      root.render(<RoleActivationPlanner {...props()} currentRuntime={visible} />)
    );
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    expect(host.textContent).toContain('rolePlanner.stale');
    expect(
      host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].getAttribute('aria-checked')
    ).toBe('false');
    await act(async () => root.unmount());
  });
  it('withdraws confirmation when the same live native process fails and cannot reconfirm it after refresh', async () => {
    const before = nativeSnapshot('connecting');
    const failed = nativeSnapshot('failed');
    expect(failed.members.worker).toMatchObject({
      alive: true,
      livenessKind: 'runtime_process',
      runtimeDiagnosticSeverity: 'error',
    });
    expect(isPlannerSnapshotTrusted(before, failed, 'fixture-team', Date.now())).toBe(false);
    const failedView = projectRuntimeForRolePlan(failed, true);
    expect(failedView.stateFor('worker')).toBe('unknown');
    expect(failedView.runningRuntimeMembers).toContain('worker');
    expect(failedView.runtimeOccupancyUncertain).toBe(true);
    getTeamAgentRuntime.mockResolvedValueOnce(before).mockResolvedValue(failed);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(<RoleActivationPlanner {...props()} currentRuntime={before} />)
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="rolePlanner.title"]')?.click();
    });
    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].click();
    });
    expect(host.textContent).toContain('rolePlanner.recommended');
    await act(async () =>
      root.render(<RoleActivationPlanner {...props()} currentRuntime={failed} />)
    );
    expect(
      host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].getAttribute('aria-checked')
    ).toBe('false');
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    const refresh = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'rolePlanner.refresh'
    );
    await act(async () => {
      refresh?.click();
    });
    expect(host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].disabled).toBe(true);
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    expect(getTeamAgentRuntime).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
