// @vitest-environment node
import { createInternalStorageCommentWarning } from '@main/internalStorageCommentWarning';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn(() => ({ show: vi.fn(), on: vi.fn() })),
    {
      isSupported: () => true,
    }
  ),
  BrowserWindow: vi.fn(),
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue({ code: 'ENOENT' }),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: () => ({
      getConfig: () => ({
        notifications: { enabled: false, ignoredRegex: [], ignoredRepositories: [] },
      }),
      clearSnooze: vi.fn(),
    }),
  },
}));

describe('storage warnings in the notification center', () => {
  it('keeps the warning unread in the focused team until the user marks it read', async () => {
    const manager = new NotificationManager();
    await manager.initialize();
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      isFocused: () => true,
      on: vi.fn(),
      removeListener: vi.fn(),
      webContents: { isDestroyed: () => false, send },
    };
    manager.setMainWindow(window as never);
    manager.setViewedTeamName('alpha');
    const report = createInternalStorageCommentWarning(
      (warning) => manager.addError(warning),
      () => 'ru'
    );
    report.onFailure('alpha', new Error('storage failed'));
    await vi.waitFor(async () => expect((await manager.getNotifications()).total).toBe(1));
    let result = await manager.getNotifications();
    expect(result.notifications[0]).toMatchObject({ source: 'internal-storage', isRead: false });
    expect(result.unreadCount).toBe(1);
    expect(
      send.mock.calls.some(
        ([channel, value]) => channel === 'notification:updated' && value.unreadCount === 1
      )
    ).toBe(true);
    manager.setViewedTeamName('alpha');
    expect(await manager.getUnreadCount()).toBe(1);
    await manager.markRead(result.notifications[0].id);
    expect(await manager.getUnreadCount()).toBe(0);

    await manager.deleteNotification(result.notifications[0].id);
    report.onMutationSuccess('alpha');
    report.onFailure('alpha', new Error('new outage'));
    await vi.waitFor(async () => expect((await manager.getNotifications()).total).toBe(1));
    result = await manager.getNotifications();
    expect(result.notifications[0].isRead).toBe(false);
    expect(result.unreadCount).toBe(1);
  });
});
