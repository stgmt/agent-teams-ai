import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ activeContextId: 'ctx-a', isContextSwitching: false }));
vi.mock('@renderer/store', () => {
  const getState = () => fixture;
  return {
    useStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
    }),
  };
});
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

import { TeamKanbanActionError } from '@renderer/components/team/TeamKanbanActionError';
import { runTeamTaskAction } from '@renderer/components/team/runTeamTaskAction';
import { subscribeTaskActionEvents } from '@renderer/store/team/taskActionInFlight';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';

describe('Kanban task action coordination', () => {
  let element: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fixture.activeContextId = 'ctx-a';
    fixture.isContextSwitching = false;
    element = document.createElement('div');
    document.body.appendChild(element);
    root = createRoot(element);
  });
  afterEach(() => {
    act(() => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  });

  it('blocks a second action for the task and displays a late failure on the active Kanban', async () => {
    let fail!: (error: Error) => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        })
    );
    const other = vi.fn(async () => {});
    act(() => root.render(<TeamKanbanActionError teamName="alpha" error={null} />));
    act(() => {
      runTeamTaskAction('alpha', '1', operation);
      runTeamTaskAction('alpha', '1', operation);
      runTeamTaskAction('alpha', '2', other);
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error('Action outcome is unknown')));
    expect(element.textContent).toContain('Action outcome is unknown');
  });

  it('does not send when an action listener switches context during acquisition', () => {
    const unsubscribe = subscribeTaskActionEvents(() => {
      fixture.activeContextId = 'ctx-b';
    });
    const operation = vi.fn(async () => {});
    runTeamTaskAction('alpha', '1', operation);
    unsubscribe();
    expect(operation).not.toHaveBeenCalled();
  });

  it('invalidates a second stage after the context changes away and back', async () => {
    let continueFirst!: () => void;
    const second = vi.fn();
    runTeamTaskAction('alpha', '1', async (isCurrent) => {
      await new Promise<void>((resolve) => {
        continueFirst = resolve;
      });
      if (isCurrent()) second();
    });
    invalidateContextScopedRequestEpoch();
    await act(async () => continueFirst());
    expect(second).not.toHaveBeenCalled();
  });
});
