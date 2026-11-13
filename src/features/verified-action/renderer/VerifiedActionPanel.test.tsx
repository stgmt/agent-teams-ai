import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VerifiedActionPanel } from './VerifiedActionPanel';

import type { VerifiedAction } from '../contracts';
import type { TaskWriteDecision } from '@features/team-task-detail/contracts';
import type { Root } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  decide: vi.fn(),
  fenceDecision: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: mocks.translate }),
}));
vi.mock('@renderer/api', () => ({ api: { verifiedAction: mocks } }));

const action: VerifiedAction = {
  id: 'b'.repeat(64),
  scope: 'scope',
  teamName: 'team',
  taskId: 'task',
  proof: { attachmentId: 'report', sha256: 'a'.repeat(64), size: 23 },
  status: 'awaiting_approval',
  attempts: 0,
  createdAt: 'now',
  updatedAt: 'now',
};

const expected = {
  appInstanceId: 'app',
  dataRootFingerprint: 'a'.repeat(64),
  connectionGeneration: 1,
};
const expectedRootFingerprint = 'c'.repeat(64);
const guard = {
  taskWriteGuard: {
    status: 'ready' as const,
    reason: null,
    activeId: null,
    markerId: null,
    operation: null,
    unknown: false,
    checked: false,
    expectedContext: expected,
    expectedRootFingerprint,
    decision: null,
  },
  beginGuardedTaskWrite: vi.fn(async () => ({
    token: 'guard-token',
    expectedContext: expected,
    expectedRootFingerprint,
  })),
  beginGuardedTaskDecision: vi.fn(
    async (actionId: string, decision: 'completed' | 'retry_once' | 'leave_unresolved') => ({
      token: 'guard-token',
      decision: {
        actionId,
        decisionId: '11111111-1111-4111-8111-111111111111',
        decision,
        stage: 'decision' as const,
      },
      expectedContext: expected,
      expectedRootFingerprint,
    })
  ),
  markGuardedDecisionFenceSent: vi.fn(
    async (): Promise<string | null> => '22222222-2222-4222-8222-222222222222'
  ),
  releaseUnadmittedDecisionFence: vi.fn(async () => true),
  readGuardedTaskDecisionIds: vi.fn(async (): Promise<string[]> => []),
  settleGuardedTaskWrite: vi.fn(async () => true),
  checkGuardedTaskWriteOutcome: vi.fn(
    async (): Promise<{
      expectedContext: typeof expected;
      expectedRootFingerprint: string;
      manifest: { markerId: string; decision: TaskWriteDecision | null; resolved?: true };
    }> => ({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: {
        markerId: 'decision-token',
        decision: {
          actionId: action.id,
          decisionId: '11111111-1111-4111-8111-111111111111',
          decision: 'retry_once',
          stage: 'decision',
        },
      },
    })
  ),
  confirmGuardedTaskWriteOutcome: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

type PanelGuard = React.ComponentProps<typeof VerifiedActionPanel>['guard'];

function renderPanel(root: Root, guardValue: PanelGuard): void {
  const element = (
    <VerifiedActionPanel
      contextId="local"
      teamName="team"
      taskId="task"
      enabled
      canMutate={() => true}
      guard={guardValue}
    />
  );
  root.render(element);
}

describe('VerifiedActionPanel', () => {
  it('shows preparation again after a replacement makes an unapproved action stale', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list
      .mockReset()
      .mockResolvedValueOnce([action])
      .mockResolvedValueOnce([{ ...action, status: 'stale' }]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (artifactRevision: string) =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          artifactRevision={artifactRevision}
          canMutate={() => true}
          guard={guard}
        />
      );
    await act(async () => render('first'));
    expect(host.textContent).toContain('verifiedAction.approve');
    expect(host.textContent).not.toContain('verifiedAction.prepare');
    await act(async () => render('replacement'));
    expect(host.textContent).toContain('verifiedAction.stale');
    expect(button(host, 'verifiedAction.prepare').disabled).toBe(false);
    expect(host.textContent).not.toContain('verifiedAction.approve');
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('checks and fences with the confirmed same-root binding after admission reopens', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const bound = new BoundControlContext('app', 'same-root');
    const oldContext = bound.snapshot();
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        expectedContext: oldContext,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId,
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    const question = { ...action, status: 'question' as const, attempts: 1 };
    mocks.list.mockReset().mockImplementation(async (_contextId, context, root) => {
      bound.assertExpected(context);
      expect(root).toBe(expectedRootFingerprint);
      return [question];
    });
    mocks.fenceDecision.mockReset().mockImplementation(async (_contextId, context, root) => {
      bound.assertExpected(context);
      expect(root).toBe(expectedRootFingerprint);
      return {
        outcome: 'applied',
        action: {
          ...question,
          status: 'manual',
          decisionReceipt: { id: decisionId, decision: 'retry_once' },
        },
      };
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => renderPanel(root, pending));
    await bound.closeAdmission();
    bound.rebind('same-root');
    const newContext = bound.snapshot();
    expect(() => bound.assertExpected(oldContext)).toThrow(/APP_CONTEXT_MISMATCH/);
    let finishCheck!: (value: {
      expectedContext: typeof expected;
      expectedRootFingerprint: string;
      manifest: { markerId: string; decision: TaskWriteDecision | null; resolved?: true };
    }) => void;
    guard.checkGuardedTaskWriteOutcome.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        })
    );
    mocks.list.mockClear();
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () =>
      renderPanel(root, {
        ...pending,
        taskWriteGuard: { ...pending.taskWriteGuard, expectedContext: newContext },
      })
    );
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () =>
      finishCheck({
        expectedContext: newContext,
        expectedRootFingerprint,
        manifest: { markerId: 'decision-token', decision: pending.taskWriteGuard.decision },
      })
    );
    expect(mocks.list).toHaveBeenCalledWith(
      'local',
      newContext,
      expectedRootFingerprint,
      'team',
      'task'
    );
    expect(mocks.fenceDecision).toHaveBeenCalledWith(
      'local',
      newContext,
      expectedRootFingerprint,
      action.id,
      'retry_once',
      decisionId
    );
    expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledWith('decision-token', 'manifest');
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('sends the claimed recovery fence once even when the artifact changes before dispatch', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const question = { ...action, status: 'question' as const, attempts: 1 };
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId,
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    let finishClaim!: (claimed: string | null) => void;
    guard.markGuardedDecisionFenceSent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClaim = resolve;
        })
    );
    mocks.list.mockReset().mockResolvedValue([question]);
    mocks.fenceDecision.mockReset().mockResolvedValue({
      outcome: 'applied',
      action: {
        ...question,
        status: 'manual',
        decisionReceipt: { id: decisionId, decision: 'retry_once' },
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (artifactRevision: string) =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          artifactRevision={artifactRevision}
          canMutate={() => true}
          guard={pending}
        />
      );
    await act(async () => render('original'));
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(guard.markGuardedDecisionFenceSent).toHaveBeenCalledOnce();
    await act(async () => render('replacement'));
    await act(async () => finishClaim('22222222-2222-4222-8222-222222222222'));
    expect(mocks.fenceDecision).toHaveBeenCalledExactlyOnceWith(
      'local',
      expected,
      expectedRootFingerprint,
      action.id,
      'retry_once',
      decisionId
    );
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([
      {
        ...question,
        status: 'manual',
        decisionReceipt: { id: decisionId, decision: 'retry_once' },
      },
    ]);
    const recovered = {
      ...pending,
      taskWriteGuard: {
        ...pending.taskWriteGuard,
        decision: { ...pending.taskWriteGuard.decision, stage: 'fenceSent' as const },
      },
    };
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          artifactRevision="replacement"
          canMutate={() => true}
          guard={recovered}
        />
      )
    );
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledExactlyOnceWith(
      'decision-token',
      'manifest'
    );
    expect(mocks.fenceDecision).toHaveBeenCalledOnce();
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not replay a decision already explicitly resolved by another window', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const stale = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId: '11111111-1111-4111-8111-111111111111',
          decision: 'retry_once' as const,
          stage: 'fenceSent' as const,
        },
      },
    };
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'decision-token', decision: null, resolved: true },
    });
    mocks.list.mockReset().mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={stale}
        />
      )
    );
    mocks.list.mockClear();
    guard.readGuardedTaskDecisionIds.mockResolvedValueOnce([action.id]);
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(guard.markGuardedDecisionFenceSent).not.toHaveBeenCalled();
    expect(mocks.fenceDecision).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('verifiedAction.question');
    await act(async () => root.unmount());
  });

  it.each([false, true])(
    'keeps the disabled panel reachable if reading a resolved result fails (stale question: %s)',
    async (staleQuestion) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const stale = {
        ...guard,
        taskWriteGuard: {
          ...guard.taskWriteGuard,
          markerId: 'decision-token',
          operation: 'manifest' as const,
          unknown: true,
        },
      };
      let rejectRead!: (reason: Error) => void;
      mocks.list
        .mockReset()
        .mockResolvedValueOnce(
          staleQuestion ? [{ ...action, status: 'question', attempts: 1 }] : []
        )
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectRead = reject;
            })
        );
      guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
        expectedContext: expected,
        expectedRootFingerprint,
        manifest: { markerId: 'decision-token', decision: null, resolved: true },
      });
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const render = (value: typeof guard | typeof stale) =>
        root.render(
          <VerifiedActionPanel
            contextId="local"
            teamName="team"
            taskId="task"
            enabled={false}
            canMutate={() => true}
            guard={value}
          />
        );
      await act(async () => render(stale));
      await act(async () => {
        button(host, 'verifiedAction.guardCheck').click();
      });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      await act(async () => render(guard));
      expect(button(host, 'verifiedAction.refresh').disabled).toBe(true);
      await act(async () => {
        rejectRead(new Error('read failed'));
      });
      expect(host.textContent).toContain('verifiedAction.refreshFailed');
      expect(host.textContent).not.toContain('verifiedAction.question');
      expect(button(host, 'verifiedAction.refresh').disabled).toBe(false);
      mocks.list.mockResolvedValueOnce([
        { ...action, status: 'completed', completion: 'user_attested' },
      ]);
      await act(async () => button(host, 'verifiedAction.refresh').click());
      expect(host.textContent).toContain('verifiedAction.attested');
      expect(mocks.fenceDecision).not.toHaveBeenCalled();
      expect(mocks.decide).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      await act(async () => root.unmount());
    }
  );

  it('uses the freshly synchronized decision during this check rather than a stale render', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const decision = {
      actionId: action.id,
      decisionId,
      decision: 'retry_once' as const,
      stage: 'decision' as const,
    };
    const stale = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: { ...decision, stage: 'fenceSent' as const },
      },
    };
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'decision-token', decision },
    });
    const question = { ...action, status: 'question' as const, attempts: 1 };
    mocks.list.mockReset().mockResolvedValue([question]);
    mocks.fenceDecision.mockReset().mockResolvedValue({
      outcome: 'applied',
      action: {
        ...question,
        status: 'manual',
        decisionReceipt: { id: decisionId, decision: 'retry_once' },
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={stale}
        />
      )
    );
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(guard.markGuardedDecisionFenceSent).toHaveBeenCalledExactlyOnceWith(
      'decision-token',
      expectedRootFingerprint,
      decision
    );
    expect(mocks.fenceDecision).toHaveBeenCalledOnce();
    expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledOnce();
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not send a fence when the checked marker differs from the requested marker', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const stale = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId: '11111111-1111-4111-8111-111111111111',
          decision: 'retry_once' as const,
          stage: 'fenceSent' as const,
        },
      },
    };
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'another-token', decision: stale.taskWriteGuard.decision },
    });
    mocks.list.mockReset().mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={stale}
        />
      )
    );
    mocks.list.mockClear();
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.list).not.toHaveBeenCalled();
    expect(guard.markGuardedDecisionFenceSent).not.toHaveBeenCalled();
    expect(mocks.fenceDecision).not.toHaveBeenCalled();
    expect(host.textContent).toContain('verifiedAction.refreshFailed');
    await act(async () => root.unmount());
  });

  it('ignores a late confirmed binding after switching to another physical root', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId: '11111111-1111-4111-8111-111111111111',
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    mocks.list.mockReset().mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    let finishCheck!: (value: {
      expectedContext: typeof expected;
      expectedRootFingerprint: string;
      manifest: { markerId: string; decision: TaskWriteDecision | null; resolved?: true };
    }) => void;
    guard.checkGuardedTaskWriteOutcome.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => renderPanel(root, pending));
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    await act(async () =>
      renderPanel(root, {
        ...pending,
        taskWriteGuard: { ...pending.taskWriteGuard, expectedRootFingerprint: 'd'.repeat(64) },
      })
    );
    mocks.list.mockClear();
    await act(async () =>
      finishCheck({
        expectedContext: expected,
        expectedRootFingerprint,
        manifest: { markerId: 'decision-token', decision: pending.taskWriteGuard.decision },
      })
    );
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.fenceDecision).not.toHaveBeenCalled();
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not allow a manual confirmation when the subsequent action read fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'old-token',
        operation: 'manifest' as const,
        unknown: true,
      },
    };
    mocks.list
      .mockReset()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('read unavailable'))
      .mockResolvedValueOnce([]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (checked: boolean) =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={{ ...pending, taskWriteGuard: { ...pending.taskWriteGuard, checked } }}
        />
      );
    await act(async () => render(false));
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'old-token', decision: null },
    });
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    await act(async () => render(true));
    expect(host.textContent).toContain('verifiedAction.refreshFailed');
    expect(host.textContent).not.toContain('verifiedAction.guardAllow');
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    await act(async () => button(host, 'verifiedAction.refresh').click());
    expect(button(host, 'verifiedAction.guardAllow').disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it('recovers the exact saved answer after the decide response was lost without another question', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId,
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    mocks.list.mockResolvedValue([
      {
        ...action,
        status: 'manual',
        attempts: 2,
        decisionReceipt: { id: decisionId, decision: 'retry_once' },
      },
    ]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={pending}
        />
      );
    });
    expect(host.textContent).not.toContain('verifiedAction.question');
    await act(async () => {
      button(host, 'verifiedAction.guardCheck').click();
    });
    expect(guard.confirmGuardedTaskWriteOutcome).toHaveBeenCalledWith('decision-token', 'manifest');
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.fenceDecision).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('verifiedAction.guardAllow');
    await act(async () => root.unmount());
  });

  it('does not release or resend a fence after timeout, even if an unadmitted response arrives late', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId: '11111111-1111-4111-8111-111111111111',
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    const restored = {
      ...pending,
      taskWriteGuard: {
        ...pending.taskWriteGuard,
        decision: { ...pending.taskWriteGuard.decision, stage: 'fenceSent' as const },
      },
    };
    let finishFence!: (result: { outcome: 'not_admitted' }) => void;
    mocks.list.mockReset().mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    mocks.fenceDecision.mockReset().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFence = resolve;
        })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => renderPanel(root, pending));
    vi.useFakeTimers();
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.fenceDecision).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(host.textContent).toContain('verifiedAction.refreshFailed');
    expect(guard.releaseUnadmittedDecisionFence).not.toHaveBeenCalled();
    await act(async () => renderPanel(root, restored));
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'decision-token', decision: restored.taskWriteGuard.decision },
    });
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    await act(async () => finishFence({ outcome: 'not_admitted' }));
    expect(mocks.fenceDecision).toHaveBeenCalledOnce();
    expect(guard.releaseUnadmittedDecisionFence).not.toHaveBeenCalled();
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('fences a saved answer once and does not resend an ambiguous fence after restart', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const decisionId = '11111111-1111-4111-8111-111111111111';
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'decision-token',
        operation: 'manifest' as const,
        unknown: true,
        decision: {
          actionId: action.id,
          decisionId,
          decision: 'retry_once' as const,
          stage: 'decision' as const,
        },
      },
    };
    const restored = {
      ...pending,
      taskWriteGuard: {
        ...pending.taskWriteGuard,
        decision: { ...pending.taskWriteGuard.decision, stage: 'fenceSent' as const },
      },
    };
    mocks.list.mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    mocks.fenceDecision.mockRejectedValueOnce(new Error('response lost'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => renderPanel(root, pending));
    expect(host.textContent).not.toContain('verifiedAction.question');
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.fenceDecision).toHaveBeenCalledTimes(1);
    expect(guard.markGuardedDecisionFenceSent).toHaveBeenCalledTimes(1);
    expect(guard.releaseUnadmittedDecisionFence).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    const newRoot = createRoot(host);
    await act(async () =>
      newRoot.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={restored}
        />
      )
    );
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'decision-token', decision: restored.taskWriteGuard.decision },
    });
    await act(async () => button(host, 'verifiedAction.guardCheck').click());
    expect(mocks.fenceDecision).toHaveBeenCalledTimes(1);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('verifiedAction.question');
    expect(host.textContent).not.toContain('verifiedAction.guardAllow');
    await act(async () => newRoot.unmount());
  });

  it('hides a question answered in another window when this window regains focus', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    guard.readGuardedTaskDecisionIds.mockResolvedValueOnce([]).mockResolvedValueOnce([action.id]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      )
    );
    expect(host.textContent).toContain('verifiedAction.question');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(host.textContent).not.toContain('verifiedAction.question');
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('reports when a new action could not be started', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValue([action]);
    guard.beginGuardedTaskWrite.mockRejectedValueOnce(new Error('storage unavailable'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      )
    );
    await act(async () => button(host, 'verifiedAction.approve').click());
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(host.textContent).toContain('verifiedAction.guardUnavailable');
    await act(async () => root.unmount());
  });

  it('refreshes a stale question if another window already recorded its answer', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    guard.readGuardedTaskDecisionIds
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([action.id])
      .mockResolvedValueOnce([action.id]);
    guard.beginGuardedTaskDecision.mockRejectedValueOnce(new Error('already decided'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      )
    );
    expect(host.textContent).toContain('verifiedAction.question');
    await act(async () => button(host, 'verifiedAction.retry').click());
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('verifiedAction.question');
    expect(host.textContent).not.toContain('verifiedAction.guardUnavailable');
    await act(async () => root.unmount());
  });
  it('does not repeat a write when its response is lost and offers the saved question after a status read', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list
      .mockResolvedValueOnce([action])
      .mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    mocks.approve.mockRejectedValueOnce(new Error('lost response'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      button(host, 'verifiedAction.approve').click();
    });
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(button(host, 'verifiedAction.approve').disabled).toBe(true);
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      button(host, 'verifiedAction.refresh').click();
    });
    expect(host.textContent).toContain('verifiedAction.question');
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('only sends a retry decision after the user selects it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    mocks.decide.mockResolvedValueOnce({
      ...action,
      status: 'manual',
      attempts: 2,
      decisionReceipt: { id: '11111111-1111-4111-8111-111111111111', decision: 'retry_once' },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      button(host, 'verifiedAction.retry').click();
    });
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide).toHaveBeenCalledWith(
      'local',
      expected,
      expectedRootFingerprint,
      action.id,
      'retry_once',
      '11111111-1111-4111-8111-111111111111'
    );
    expect(host.textContent).toContain('verifiedAction.manual');
    expect(host.textContent).not.toContain('verifiedAction.question');
    expect(guard.settleGuardedTaskWrite).toHaveBeenCalledWith(
      'guard-token',
      'manifest',
      'confirmed'
    );
    await act(async () => {
      root.unmount();
    });
  });

  it('discards a late status response from a previously selected task', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveOld!: (value: VerifiedAction[]) => void;
    mocks.list
      .mockReturnValueOnce(
        new Promise<VerifiedAction[]>((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockResolvedValueOnce([
        { ...action, taskId: 'next', proof: { ...action.proof, attachmentId: 'new-report' } },
      ]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="next"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      resolveOld([{ ...action, proof: { ...action.proof, attachmentId: 'old-report' } }]);
    });
    expect(host.textContent).toContain('new-report');
    expect(host.textContent).not.toContain('old-report');
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps a saved question reachable after the artifact requirement is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([{ ...action, status: 'question', attempts: 1 }]);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled={false}
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(host.textContent).toContain('verifiedAction.question');
    expect(host.textContent).not.toContain('verifiedAction.prepare');
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps an interrupted preparation reachable when the requirement is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([]);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'old-token',
        operation: 'manifest' as const,
        unknown: true,
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled={false}
          canMutate={() => true}
          guard={pending}
        />
      );
    });
    expect(host.textContent).toContain('verifiedAction.guardUnknown');
    expect(button(host, 'verifiedAction.guardCheck').disabled).toBe(false);
    await act(async () => {
      root.unmount();
    });
  });

  it('hides the local queue and never reads it from a remote context', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="ssh:host"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    expect(host.textContent).toBe('');
    expect(mocks.list).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('does not start a manifest while an artifact write holds the shared guard', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.list.mockResolvedValueOnce([action]);
    const occupied = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        activeId: 'artifact-write',
        operation: 'artifact' as const,
      },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={occupied}
        />
      );
    });
    expect(button(host, 'verifiedAction.approve').disabled).toBe(true);
    expect(host.textContent).toContain('verifiedAction.guardBlocked');
    expect(guard.beginGuardedTaskWrite).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it('checks a restored manifest marker before an explicit retry and never retries on its own', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const pending = {
      ...guard,
      taskWriteGuard: {
        ...guard.taskWriteGuard,
        markerId: 'old-token',
        operation: 'manifest' as const,
        unknown: true,
      },
    };
    const checked = { ...pending, taskWriteGuard: { ...pending.taskWriteGuard, checked: true } };
    mocks.list.mockResolvedValue([{ ...action, status: 'question', attempts: 1 }]);
    mocks.decide.mockResolvedValueOnce({
      ...action,
      status: 'completed',
      completion: 'queued',
      attempts: 2,
      decisionReceipt: { id: '11111111-1111-4111-8111-111111111111', decision: 'retry_once' },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      renderPanel(root, pending);
    });
    expect(button(host, 'verifiedAction.retry').disabled).toBe(true);
    expect(mocks.decide).not.toHaveBeenCalled();
    guard.checkGuardedTaskWriteOutcome.mockResolvedValueOnce({
      expectedContext: expected,
      expectedRootFingerprint,
      manifest: { markerId: 'old-token', decision: null },
    });
    await act(async () => {
      button(host, 'verifiedAction.guardCheck').click();
    });
    expect(guard.checkGuardedTaskWriteOutcome).toHaveBeenCalledWith('manifest');
    expect(mocks.decide).not.toHaveBeenCalled();
    await act(async () => {
      renderPanel(root, checked);
    });
    await act(async () => {
      button(host, 'verifiedAction.retry').click();
    });
    expect(guard.confirmGuardedTaskWriteOutcome).not.toHaveBeenCalled();
    expect(guard.beginGuardedTaskDecision).toHaveBeenCalledWith(action.id, 'retry_once');
    expect(mocks.decide).toHaveBeenCalledOnce();
    expect(mocks.decide).toHaveBeenCalledWith(
      'local',
      expected,
      expectedRootFingerprint,
      action.id,
      'retry_once',
      '11111111-1111-4111-8111-111111111111'
    );
    await act(async () => {
      root.unmount();
    });
  });

  it('keeps a timed-out write unknown when its response arrives late', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    mocks.list.mockResolvedValueOnce([action]);
    let resolveWrite!: (value: VerifiedAction) => void;
    mocks.approve.mockReturnValueOnce(
      new Promise<VerifiedAction>((resolve) => {
        resolveWrite = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <VerifiedActionPanel
          contextId="local"
          teamName="team"
          taskId="task"
          enabled
          canMutate={() => true}
          guard={guard}
        />
      );
    });
    await act(async () => {
      button(host, 'verifiedAction.approve').click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(guard.settleGuardedTaskWrite).toHaveBeenCalledWith('guard-token', 'manifest', 'unknown');
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      resolveWrite({ ...action, status: 'completed', completion: 'queued', attempts: 1 });
    });
    expect(guard.settleGuardedTaskWrite).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('verifiedAction.resultUnknown');
    await act(async () => {
      root.unmount();
    });
    vi.useRealTimers();
  });
});
