// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectedError } from '@renderer/types/data';

const state = vi.hoisted(() => ({
  notifications: [] as DetectedError[],
  unreadCount: 1,
  fetchNotifications: vi.fn(async () => undefined),
  markNotificationRead: vi.fn(async () => undefined),
  markAllNotificationsRead: vi.fn(async () => undefined),
  deleteNotification: vi.fn(async () => undefined),
  clearNotifications: vi.fn(async () => undefined),
  navigateToError: vi.fn(),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 56,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        size: 56,
        start: index * 56,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

const { NotificationsView } = await import('@renderer/components/notifications/NotificationsView');

const message =
  'Внутреннее хранилище недоступно. '.repeat(5) +
  'Проверьте состояние хранилища и последние действия вручную.';
const warning = (team = false): DetectedError => ({
  id: 'warning-1',
  timestamp: Date.now(),
  createdAt: Date.now(),
  sessionId: team ? 'team:alpha' : 'internal-storage',
  projectId: team ? 'alpha' : 'internal-storage',
  filePath: '',
  source: 'internal-storage',
  triggerName: 'Внутреннее хранилище',
  message,
  isRead: false,
  requiresAcknowledgement: true,
  target: team ? { kind: 'team', teamName: 'alpha', section: 'tasks' } : undefined,
  context: { projectName: team ? 'alpha' : 'Внутреннее хранилище' },
});

describe('storage warning details', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.clearAllMocks();
    state.notifications = [warning()];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('opens the entire global warning from its keyboard-accessible row', async () => {
    await act(async () => root.render(<NotificationsView />));
    const row = host.querySelector('[role="button"]')!;
    await act(async () =>
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(message);
    expect(state.markNotificationRead).toHaveBeenCalledWith('warning-1');
    expect(state.navigateToError).not.toHaveBeenCalled();
  });

  it('lets the user read the full warning before opening the affected team', async () => {
    state.notifications = [warning(true)];
    await act(async () => root.render(<NotificationsView />));
    const row = host.querySelector('[role="button"]') as HTMLElement;
    await act(async () => row.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(message);
    const openTeam = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'dialogs.actions.openTeam'
    )!;
    await act(async () => openTeam.click());
    expect(state.navigateToError).toHaveBeenCalledWith(state.notifications[0]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
