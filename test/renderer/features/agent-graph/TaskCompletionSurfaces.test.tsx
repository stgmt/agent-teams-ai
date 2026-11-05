import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationNodeDto } from '@features/organizations/contracts';
import type { TeamTaskWithKanban } from '@shared/types';

const fixtures = vi.hoisted(() => ({
  updateTaskStatus: vi.fn(),
  updateKanban: vi.fn(),
  requestReview: vi.fn(),
  activeContextId: 'test',
  isContextSwitching: false,
  teamData: {} as Record<string, unknown>,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) =>
      ({
        'artifact.actionMissing': 'Attach the required artifact to the task before continuing.',
        'artifact.actionInvalid': 'The required artifact cannot be verified.',
        'actions.close': 'Close',
        'kanban.taskCard.complete': 'Complete',
        'kanban.taskCard.approve': 'Approve',
        'kanban.taskCard.requestReview': 'Request review',
      })[key] ?? key,
  }),
}));
vi.mock('@renderer/api', () => ({ api: { teams: { processSend: vi.fn() } } }));
vi.mock('@renderer/store', () => {
  const getState = () => ({
    selectedTeamName: 'unrelated-selected-team',
    activeContextId: fixtures.activeContextId,
    isContextSwitching: fixtures.isContextSwitching,
    globalTasks: [],
    updateTaskStatus: fixtures.updateTaskStatus,
    updateKanban: fixtures.updateKanban,
    requestReview: fixtures.requestReview,
  });
  return {
    useStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
    }),
  };
});
vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: (_state: unknown, teamName: string) => fixtures.teamData[teamName],
  selectResolvedMembersForTeamName: () => [],
}));
vi.mock('@renderer/components/team/dialogs/ReviewDialog', () => ({ ReviewDialog: () => null }));
vi.mock('@renderer/components/common/ConfirmDialog', () => ({ confirm: vi.fn() }));
vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock('@renderer/components/team/UnreadCommentsBadge', () => ({
  UnreadCommentsBadge: () => null,
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/hooks/useUnreadCommentCount', () => ({ useUnreadCommentCount: () => 0 }));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphActivityContext', () => ({
  useGraphActivityContext: (teamName: string) => ({
    contextId: 'test',
    teamData: fixtures.teamData[teamName],
  }),
}));
vi.mock('@claude-teams/agent-graph', () => ({
  GraphView: ({
    data,
    renderOverlay,
    onRequestFullscreen,
    onRequestClose,
  }: {
    data: { nodes: unknown[] };
    renderOverlay: (props: { node: unknown; onClose: () => void }) => React.ReactNode;
    onRequestFullscreen?: () => void;
    onRequestClose?: () => void;
  }) => {
    const [open, setOpen] = React.useState(true);
    return (
      <div>
        <button onClick={() => setOpen(true)}>Open task</button>
        {onRequestFullscreen ? <button onClick={onRequestFullscreen}>Fullscreen</button> : null}
        {onRequestClose ? <button onClick={onRequestClose}>Exit fullscreen</button> : null}
        {open ? renderOverlay({ node: data.nodes[0], onClose: () => setOpen(false) }) : null}
      </div>
    );
  },
}));
vi.mock('@features/agent-graph/renderer/hooks/useTeamGraphAdapter', () => ({
  useTeamGraphAdapter: (teamName: string) => ({
    nodes: [
      {
        id: `task:${teamName}:task-1`,
        kind: 'task',
        label: 'Sandbox task',
        state: 'active',
        domainRef: { kind: 'task', teamName, taskId: 'task-1' },
      },
    ],
    edges: [],
  }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useTeamGraphSurfaceActions', () => ({
  useTeamGraphSurfaceActions: () => ({ openTeamPage: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphSidebarVisibility', () => ({
  useGraphSidebarVisibility: () => ({ sidebarVisible: false }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphMessagesPanel', () => ({
  useGraphMessagesPanel: () => null,
}));
vi.mock('@renderer/components/team/sidebar/TeamSidebarPortalManager', () => ({
  useTeamSidebarPortalSnapshot: () => ({ activeSourceIdByTeam: {} }),
}));
vi.mock('@renderer/components/team/sidebar/TeamSidebarHost', () => ({
  TeamSidebarHost: () => null,
}));
vi.mock('@features/terminal-workspace/renderer', () => ({
  TerminalWorkspaceFloatingLauncher: () => null,
}));
vi.mock('@features/announcements/renderer', () => ({ AnnouncementNewsButton: () => null }));
vi.mock('@features/agent-graph/renderer/hooks/useGraphChangeReviewDialog', () => ({
  useGraphChangeReviewDialog: () => ({ dialog: null, openTaskChanges: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphCreateTaskDialog', () => ({
  useGraphCreateTaskDialog: () => ({ dialog: null, openCreateTaskDialog: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphMemberDetailDialog', () => ({
  useGraphMemberDetailDialog: () => ({ dialog: null, openMemberProfile: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphSendMessageDialog', () => ({
  useGraphSendMessageDialog: () => ({ dialog: null, openSendMessage: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/hooks/useGraphTaskDetailDialog', () => ({
  useGraphTaskDetailDialog: () => ({ dialog: null, openTaskDetail: () => undefined }),
}));
vi.mock('@features/agent-graph/renderer/ui/GraphActivityHud', () => ({
  GraphActivityHud: () => null,
}));
vi.mock('@features/agent-graph/renderer/ui/GraphBlockingEdgePopover', () => ({
  GraphBlockingEdgePopover: () => null,
}));
vi.mock('@features/agent-graph/renderer/ui/GraphMemberLogPreviewHud', () => ({
  GraphMemberLogPreviewHud: () => null,
}));
vi.mock('@features/agent-graph/renderer/ui/GraphProvisioningHud', () => ({
  GraphProvisioningHud: () => null,
}));
vi.mock('@features/agent-graph/renderer/ui/GraphTransientHandoffHud', () => ({
  GraphTransientHandoffHud: () => null,
}));

import { useGraphTaskActions } from '@features/agent-graph/renderer/hooks/useGraphTaskActions';
import { GraphTaskCard } from '@features/agent-graph/renderer/ui/GraphTaskCard';
import { TeamGraphTab } from '@features/agent-graph/renderer/ui/TeamGraphTab';
import { OrgInspector } from '@features/organizations/renderer/ui/OrgInspector';
import {
  acquireTaskAction,
  subscribeTaskActionEvents,
} from '@renderer/store/team/taskActionInFlight';

const task: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: '1',
  subject: 'Sandbox task',
  owner: 'alice',
  reviewer: '',
  status: 'in_progress',
  changePresence: 'unknown',
  comments: [],
  blockedBy: [],
  blocks: [],
  workIntervals: [],
  historyEvents: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as TeamTaskWithKanban;

const noop = (): void => undefined;

function tasksFor(teamName: string): TeamTaskWithKanban[] {
  return (fixtures.teamData[teamName] as { tasks?: TeamTaskWithKanban[] } | undefined)?.tasks ?? [];
}

function GraphSurface({ teamName }: { teamName: string }): React.JSX.Element {
  const actions = useGraphTaskActions(teamName);
  const [closedTaskIds, setClosedTaskIds] = useState<string[]>([]);
  return (
    <div>
      <button onClick={() => setClosedTaskIds([])}>Open task</button>
      {tasksFor(teamName)
        .filter((item) => !closedTaskIds.includes(item.id))
        .map((item) => (
          <GraphTaskCard
            key={item.id}
            node={{
              id: `task:${teamName}:${item.id}`,
              kind: 'task',
              label: item.subject,
              state: 'active',
              domainRef: { kind: 'task', teamName, taskId: item.id },
            }}
            teamName={teamName}
            onClose={() => setClosedTaskIds((ids) => [...ids, item.id])}
            {...actions.taskActionHandlers}
          />
        ))}
      {actions.dialog}
    </div>
  );
}

function inspectorNode(teamName: string): OrganizationNodeDto {
  const currentTasks = tasksFor(teamName).map((item) => ({
    id: item.id,
    subject: item.subject,
    status: item.status,
  }));
  return {
    id: `team:${teamName}`,
    kind: 'team',
    label: teamName,
    team: {
      teamName,
      displayName: teamName,
      isOnline: true,
      memberCount: 1,
      taskCounts: { pending: 0, inProgress: 1, completed: 0 },
      agents: [
        {
          id: 'agent-1',
          teamName,
          name: 'alice',
          status: 'active',
          activeTaskCount: currentTasks.length,
          currentTasks,
        },
      ],
    },
  };
}

function InspectorSurface({ teamName }: { teamName: string }): React.JSX.Element {
  return (
    <OrgInspector
      node={inspectorNode(teamName)}
      childCount={0}
      canToggleCollapse={false}
      isCollapsed={false}
      onToggleCollapse={noop}
      onOpenTeam={noop}
      onOpenGraph={noop}
      onClose={noop}
    />
  );
}

const surfaces = [
  ['graph', GraphSurface],
  ['organization inspector', InspectorSurface],
] as const;

describe.each(surfaces)('%s task completion', (_name, Surface) => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  async function render(teamName: string): Promise<void> {
    await act(async () => {
      root.render(<Surface teamName={teamName} />);
    });
  }

  async function clickComplete(): Promise<void> {
    const complete = host.querySelector<HTMLButtonElement>('button[aria-label="Complete"]');
    expect(complete).not.toBeNull();
    await act(async () => {
      complete?.click();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixtures.updateTaskStatus.mockReset();
    fixtures.updateKanban.mockReset();
    fixtures.requestReview.mockReset();
    fixtures.activeContextId = 'test';
    fixtures.isContextSwitching = false;
    fixtures.teamData = Object.fromEntries(
      ['alpha', 'beta'].map((teamName) => [
        teamName,
        { tasks: [task], members: [], kanbanState: { tasks: {} } },
      ])
    );
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows the artifact error with the actual team and task and clears on success', async () => {
    fixtures.updateTaskStatus
      .mockRejectedValueOnce(new Error('A required task artifact has not been attached'))
      .mockResolvedValueOnce(undefined);
    await render('alpha');
    await clickComplete();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledExactlyOnceWith(
      'alpha',
      'task-1',
      'completed'
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Attach the required artifact'
    );
    expect(host.textContent).toContain('alpha · #1');

    if (!host.querySelector('button[aria-label="Complete"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await clickComplete();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores a delayed error after switching teams, even after returning', async () => {
    let rejectAlpha: (error: Error) => void = noop;
    fixtures.updateTaskStatus
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectAlpha = reject;
          })
      )
      .mockRejectedValueOnce(new Error('Required task artifact cannot be verified: checksum'));
    await render('alpha');
    await clickComplete();
    await render('beta');
    if (!host.querySelector('button[aria-label="Complete"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await clickComplete();
    expect(host.textContent).toContain('beta · #1');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be verified');
    await act(async () => {
      rejectAlpha(new Error('A required task artifact has not been attached'));
    });
    expect(host.textContent).not.toContain('alpha · #1');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be verified');
    await render('alpha');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fixtures.updateTaskStatus.mock.calls).toEqual([
      ['alpha', 'task-1', 'completed'],
      ['beta', 'task-1', 'completed'],
    ]);
  });

  it('dismisses the explanation without repeating the action', async () => {
    fixtures.updateTaskStatus.mockRejectedValueOnce(
      new Error('A required task artifact has not been attached')
    );
    await render('alpha');
    await clickComplete();
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    await act(async () => {
      close?.click();
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(1);
  });

  it('blocks another action for the pending task while another task proceeds', async () => {
    let rejectFirst: (error: Error) => void = noop;
    const secondTask = { ...task, id: 'task-2', displayId: '2', subject: 'Another task' };
    fixtures.teamData.alpha = {
      tasks: [task, secondTask],
      members: [],
      kanbanState: { tasks: {} },
    };
    fixtures.updateTaskStatus.mockImplementation((teamName: string, taskId: string) =>
      taskId === 'task-1'
        ? new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve()
    );
    await render('alpha');
    await act(async () => {
      host.querySelectorAll<HTMLButtonElement>('button[aria-label="Complete"]')[0]?.click();
      await Promise.resolve();
    });
    if (host.querySelectorAll('button[aria-label="Complete"]').length < 2) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await act(async () => {
      const buttons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Complete"]');
      expect(buttons).toHaveLength(2);
      buttons[0]?.click();
      buttons[1]?.click();
      await Promise.resolve();
    });
    expect(fixtures.updateTaskStatus.mock.calls).toEqual([
      ['alpha', 'task-1', 'completed'],
      ['alpha', 'task-2', 'completed'],
    ]);
    await act(async () => {
      rejectFirst(new Error('KANBAN_TRANSITION_UNCERTAIN: inspect the task and board'));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'KANBAN_TRANSITION_UNCERTAIN'
    );
    expect(host.textContent).toContain('alpha · #1');
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(2);
  });

  it('blocks a different action on the same task until the first outcome arrives', async () => {
    fixtures.teamData.alpha = {
      tasks: [{ ...task, status: 'completed' }],
      members: [],
      kanbanState: { tasks: {} },
    };
    let rejectApprove: (error: Error) => void = noop;
    fixtures.updateKanban.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectApprove = reject;
        })
    );
    await render('alpha');
    const approve = host.querySelector<HTMLButtonElement>('button[aria-label="Approve"]');
    expect(approve).not.toBeNull();
    await act(async () => {
      approve?.click();
      await Promise.resolve();
    });
    if (!host.querySelector('button[aria-label="Request review"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    const review = host.querySelector<HTMLButtonElement>('button[aria-label="Request review"]');
    expect(review).not.toBeNull();
    await act(async () => {
      review?.click();
      await Promise.resolve();
    });
    expect(fixtures.updateKanban).toHaveBeenCalledTimes(1);
    expect(fixtures.requestReview).not.toHaveBeenCalled();
    await act(async () => {
      rejectApprove(new Error('KANBAN_TRANSITION_UNCERTAIN: inspect the task and board'));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'KANBAN_TRANSITION_UNCERTAIN'
    );
  });

  it('keeps the lease when switching away and back before the response', async () => {
    let rejectAlpha: (error: Error) => void = noop;
    fixtures.updateTaskStatus.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAlpha = reject;
        })
    );
    await render('alpha');
    await clickComplete();
    await render('beta');
    await render('alpha');
    if (!host.querySelector('button[aria-label="Complete"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await clickComplete();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectAlpha(new Error('KANBAN_TRANSITION_UNCERTAIN: inspect the task and board'));
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'KANBAN_TRANSITION_UNCERTAIN'
    );
    expect(host.textContent).toContain('alpha · #1');
  });

  it('starts the action synchronously before a same-tick context change', async () => {
    let contextAtSend = '';
    fixtures.updateTaskStatus.mockImplementationOnce(() => {
      contextAtSend = fixtures.activeContextId;
      return Promise.resolve();
    });
    await render('alpha');
    const complete = host.querySelector<HTMLButtonElement>('button[aria-label="Complete"]');
    expect(complete).not.toBeNull();
    await act(async () => {
      complete?.click();
      fixtures.activeContextId = 'other-context';
      await Promise.resolve();
    });
    expect(contextAtSend).toBe('test');
    expect(fixtures.updateTaskStatus).toHaveBeenCalledExactlyOnceWith(
      'alpha',
      'task-1',
      'completed'
    );
  });

  it.each(['switching', 'changed'] as const)(
    'does not send an action when the context has %s before the click',
    async (reason) => {
      fixtures.updateTaskStatus.mockResolvedValue(undefined);
      await render('alpha');
      if (reason === 'switching') fixtures.isContextSwitching = true;
      else fixtures.activeContextId = 'other-context';
      await clickComplete();
      expect(fixtures.updateTaskStatus).not.toHaveBeenCalled();
      fixtures.activeContextId = 'test';
      fixtures.isContextSwitching = false;
      if (!host.querySelector('button[aria-label="Complete"]')) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('button')?.click();
        });
      }
      await clickComplete();
      expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(1);
    }
  );

  it('releases the task lease and shows the error if the action throws synchronously', async () => {
    fixtures.updateTaskStatus
      .mockImplementationOnce(() => {
        throw new Error('A required task artifact has not been attached');
      })
      .mockResolvedValueOnce(undefined);
    await render('alpha');
    await clickComplete();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Attach the required artifact'
    );
    if (!host.querySelector('button[aria-label="Complete"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await clickComplete();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('releases the lease if switching starts while the action is being acquired', async () => {
    fixtures.updateTaskStatus.mockResolvedValue(undefined);
    await render('alpha');
    const unsubscribe = subscribeTaskActionEvents((event) => {
      if (event.type === 'started' && event.teamName === 'alpha' && event.taskId === 'task-1') {
        fixtures.isContextSwitching = true;
      }
    });
    try {
      await clickComplete();
      expect(fixtures.updateTaskStatus).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      fixtures.isContextSwitching = false;
    }
    if (!host.querySelector('button[aria-label="Complete"]')) {
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button')?.click();
      });
    }
    await clickComplete();
    expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(1);
  });

  it('does not send the second stage of a task move after a context change', async () => {
    fixtures.teamData.alpha = {
      tasks: [{ ...task, status: 'completed', kanbanColumn: 'approved' }],
      members: [],
      kanbanState: { tasks: {} },
    };
    let finishKanban: () => void = noop;
    fixtures.updateKanban.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishKanban = resolve;
        })
    );
    await render('alpha');
    const disapprove = host.querySelector<HTMLButtonElement>('button[aria-label="Disapprove"]');
    expect(disapprove).not.toBeNull();
    await act(async () => {
      disapprove?.click();
    });
    expect(fixtures.updateKanban).toHaveBeenCalledTimes(1);
    fixtures.activeContextId = 'other-context';
    await act(async () => {
      finishKanban();
    });
    expect(fixtures.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('shows a failure when returning an approved task to done', async () => {
    fixtures.teamData.alpha = {
      tasks: [{ ...task, status: 'completed', kanbanColumn: 'approved' }],
      members: [],
      kanbanState: { tasks: {} },
    };
    fixtures.updateKanban.mockResolvedValueOnce(undefined);
    fixtures.updateTaskStatus.mockRejectedValueOnce(
      new Error('Required task artifact cannot be verified: checksum')
    );
    await render('alpha');
    const disapprove = host.querySelector<HTMLButtonElement>('button[aria-label="Disapprove"]');
    expect(disapprove).not.toBeNull();
    await act(async () => {
      disapprove?.click();
      await Promise.resolve();
    });
    expect(fixtures.updateKanban).toHaveBeenCalledExactlyOnceWith('alpha', 'task-1', {
      op: 'remove',
    });
    expect(fixtures.updateTaskStatus).toHaveBeenCalledExactlyOnceWith(
      'alpha',
      'task-1',
      'completed'
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be verified');
    expect(host.textContent).toContain('alpha · #1');
  });

  describe.each([
    {
      label: 'Approve',
      method: 'updateKanban',
      args: ['alpha', 'task-1', { op: 'set_column', column: 'approved' }],
    },
    { label: 'Request review', method: 'requestReview', args: ['alpha', 'task-1'] },
  ] as const)('$label', ({ label, method, args }) => {
    async function clickAction(): Promise<void> {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button).not.toBeNull();
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
    }

    async function reopenIfNeeded(): Promise<void> {
      if (!host.querySelector(`button[aria-label="${label}"]`)) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('button')?.click();
        });
      }
    }

    beforeEach(() => {
      const doneTask = { ...task, status: 'completed' };
      fixtures.teamData = Object.fromEntries(
        ['alpha', 'beta'].map((teamName) => [
          teamName,
          { tasks: [doneTask], members: [], kanbanState: { tasks: {} } },
        ])
      );
    });

    it('shows the artifact error for the task, dismisses it without retrying, and permits success', async () => {
      fixtures[method]
        .mockRejectedValueOnce(new Error('A required task artifact has not been attached'))
        .mockResolvedValueOnce(undefined);
      await render('alpha');
      await clickAction();
      expect(fixtures[method]).toHaveBeenCalledExactlyOnceWith(...args);
      expect(host.textContent).toContain('alpha · #1');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Attach the required artifact'
      );
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      });
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(fixtures[method]).toHaveBeenCalledTimes(1);
      await reopenIfNeeded();
      await clickAction();
      expect(fixtures[method]).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it('does not show a delayed rejection in another team or after returning', async () => {
      let rejectAlpha: (error: Error) => void = noop;
      fixtures[method]
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectAlpha = reject;
            })
        )
        .mockRejectedValueOnce(new Error('Required task artifact cannot be verified: checksum'));
      await render('alpha');
      await clickAction();
      await render('beta');
      await reopenIfNeeded();
      await clickAction();
      expect(host.textContent).toContain('beta · #1');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be verified');
      await act(async () => {
        rejectAlpha(new Error('A required task artifact has not been attached'));
      });
      expect(host.textContent).not.toContain('alpha · #1');
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('cannot be verified');
      await render('alpha');
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(fixtures[method]).toHaveBeenCalledTimes(2);
    });
  });
});

it.each([
  ['graph', GraphSurface, InspectorSurface],
  ['inspector', InspectorSurface, GraphSurface],
] as const)(
  'keeps the lease after leaving %s and delivers the late error to the new surface',
  async (_name, InitialSurface, NextSurface) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixtures.teamData = { alpha: { tasks: [task], members: [], kanbanState: { tasks: {} } } };
    fixtures.updateTaskStatus.mockReset();
    let rejectFirst: (error: Error) => void = noop;
    fixtures.updateTaskStatus
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
      )
      .mockResolvedValueOnce(undefined);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InitialSurface teamName="alpha" />);
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Complete"]')?.click();
        await Promise.resolve();
      });
      await act(async () => {
        root.render(<NextSurface teamName="alpha" />);
      });
      const complete = host.querySelector<HTMLButtonElement>('button[aria-label="Complete"]');
      expect(complete).not.toBeNull();
      await act(async () => {
        complete?.click();
        await Promise.resolve();
      });
      expect(fixtures.updateTaskStatus).toHaveBeenCalledExactlyOnceWith(
        'alpha',
        'task-1',
        'completed'
      );
      await act(async () => {
        rejectFirst(new Error('KANBAN_TRANSITION_UNCERTAIN: inspect the task and board'));
      });
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'KANBAN_TRANSITION_UNCERTAIN'
      );
      expect(host.textContent).toContain('alpha · #1');
      if (!host.querySelector('button[aria-label="Complete"]')) {
        await act(async () => {
          host.querySelector<HTMLButtonElement>('button')?.click();
        });
      }
      await act(async () => {
        host.querySelector<HTMLButtonElement>('button[aria-label="Complete"]')?.click();
        await Promise.resolve();
      });
      expect(fixtures.updateTaskStatus).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);

it('keeps task leases isolated by context, team and task and makes release idempotent', () => {
  const identity = { contextId: 'context-a', teamName: 'alpha', taskId: 'task-1' };
  const first = acquireTaskAction(identity);
  const otherContext = acquireTaskAction({ ...identity, contextId: 'context-b' });
  const otherTeam = acquireTaskAction({ ...identity, teamName: 'beta' });
  const otherTask = acquireTaskAction({ ...identity, taskId: 'task-2' });
  expect(first).not.toBeNull();
  expect(otherContext).not.toBeNull();
  expect(otherTeam).not.toBeNull();
  expect(otherTask).not.toBeNull();
  expect(acquireTaskAction(identity)).toBeNull();
  first?.();
  const next = acquireTaskAction(identity);
  expect(next).not.toBeNull();
  first?.();
  expect(acquireTaskAction(identity)).toBeNull();
  next?.();
  otherContext?.();
  otherTeam?.();
  otherTask?.();
});

it.each([
  {
    label: 'Complete',
    method: 'updateTaskStatus',
    status: 'in_progress',
    args: ['alpha', 'task-1', 'completed'],
  },
  {
    label: 'Approve',
    method: 'updateKanban',
    status: 'completed',
    args: ['alpha', 'task-1', { op: 'set_column', column: 'approved' }],
  },
  {
    label: 'Request review',
    method: 'requestReview',
    status: 'completed',
    args: ['alpha', 'task-1'],
  },
] as const)(
  'keeps a pending $label failure visible while entering and leaving fullscreen',
  async ({ label, method, status, args }) => {
    await import('@features/agent-graph/renderer/ui/TeamGraphOverlay');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixtures.teamData = {
      alpha: { tasks: [{ ...task, status }], members: [], kanbanState: { tasks: {} } },
    };
    fixtures[method].mockReset();
    let rejectTask: (error: Error) => void = noop;
    fixtures[method].mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectTask = reject;
        })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<TeamGraphTab teamName="alpha" />);
      });
      await act(async () => {
        const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        expect(button).not.toBeNull();
        button?.click();
      });
      await act(async () => {
        Array.from(host.querySelectorAll('button'))
          .find((button) => button.textContent === 'Fullscreen')
          ?.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelector('.fixed')).not.toBeNull();
      await act(async () => {
        rejectTask(new Error('A required task artifact has not been attached'));
      });
      expect(host.querySelector('.fixed [role="alert"]')?.textContent).toContain(
        'Attach the required artifact'
      );
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
      await act(async () => {
        Array.from(host.querySelectorAll('button'))
          .find((button) => button.textContent === 'Exit fullscreen')
          ?.click();
      });
      expect(host.querySelector('.fixed')).toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Attach the required artifact'
      );
      expect(fixtures[method]).toHaveBeenCalledExactlyOnceWith(...args);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
