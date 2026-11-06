import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const member = (name: string, agentType?: string): ResolvedTeamMember => ({
  name,
  agentType,
  status: 'idle',
  currentTaskId: null,
  taskCount: 0,
  lastActiveAt: null,
  messageCount: 0,
});
const snapshot = (): TeamAgentRuntimeSnapshot => ({
  teamName: 'team',
  runId: 'run-1',
  updatedAt: new Date().toISOString(),
  members: {
    'team-lead': {
      memberName: 'team-lead',
      alive: true,
      restartable: false,
      backendType: 'lead',
      pid: 1234,
      pidSource: 'lead_process',
      updatedAt: new Date().toISOString(),
    },
    worker: {
      memberName: 'worker',
      alive: false,
      restartable: true,
      livenessKind: 'not_found',
      updatedAt: new Date().toISOString(),
    },
  },
});
const props = () => ({
  teamName: 'team',
  teamAlive: true,
  members: [member('team-lead', 'team-lead'), member('worker')],
  tasks: [{ id: '1', subject: 'Implement', status: 'pending' as const, owner: 'worker' }],
  kanbanState: { teamName: 'team', reviewers: [], tasks: {} },
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getTeamAgentRuntime.mockReset();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('role planner', () => {
  it('requires an explicit availability confirmation and clears it on refresh', async () => {
    getTeamAgentRuntime.mockImplementation(async () => snapshot());
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<RoleActivationPlanner {...props()} />);
    });
    expect(getTeamAgentRuntime).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="rolePlanner.title"]')?.click();
    });
    expect(getTeamAgentRuntime).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('rolePlanner.reasons.availability_unknown');
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    const boxes = host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    expect(boxes).toHaveLength(2);
    await act(async () => {
      boxes[1].click();
    });
    expect(host.textContent).toContain('rolePlanner.recommended');
    expect(host.textContent).toContain('rolePlanner.newSlot');
    const refresh = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'rolePlanner.refresh'
    );
    await act(async () => {
      refresh?.click();
    });
    expect(getTeamAgentRuntime).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('rolePlanner.reasons.availability_unknown');
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    await act(async () => root.unmount());
  });

  it('shows a failure without retrying or inventing availability', async () => {
    getTeamAgentRuntime.mockRejectedValue(new Error('unavailable'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<RoleActivationPlanner {...props()} />);
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="rolePlanner.title"]')?.click();
    });
    expect(getTeamAgentRuntime).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('rolePlanner.refreshFailed');
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    await act(async () => root.unmount());
  });

  it('invalidates confirmation if the shared runtime changes', async () => {
    const initial = snapshot();
    getTeamAgentRuntime.mockResolvedValue(initial);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<RoleActivationPlanner {...props()} currentRuntime={initial} />);
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="rolePlanner.title"]')?.click();
    });
    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')[1].click();
    });
    expect(host.textContent).toContain('rolePlanner.recommended');
    const changed = {
      ...initial,
      members: {
        ...initial.members,
        worker: { ...initial.members.worker, runtimeModel: 'new-model' },
      },
    };
    await act(async () => {
      root.render(<RoleActivationPlanner {...props()} currentRuntime={changed} />);
    });
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    expect(host.textContent).toContain('rolePlanner.stale');
    await act(async () => {
      root.render(<RoleActivationPlanner {...props()} currentRuntime={initial} />);
    });
    expect(host.textContent).not.toContain('rolePlanner.recommended');
    expect(host.textContent).toContain('rolePlanner.reasons.availability_unknown');
    expect(getTeamAgentRuntime).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
