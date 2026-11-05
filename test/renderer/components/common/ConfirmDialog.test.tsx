import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { confirm, ConfirmDialog } from '@renderer/components/common/ConfirmDialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

describe('ConfirmDialog modes', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<ConfirmDialog />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('confirms an action through the focused confirmation button', async () => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = confirm({ title: 'Delete?', message: 'Confirm deletion' });
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-confirm-btn]')).toBe(document.activeElement);
    await act(async () =>
      (dialog.querySelector('[data-confirm-btn]') as HTMLButtonElement).click()
    );
    await expect(result).resolves.toBe(true);
  });

  it('resolves an informational dialog through its action', async () => {
    let result!: Promise<boolean>;
    await act(async () => {
      result = confirm({
        mode: 'info',
        title: 'Stopped?',
        message: 'Unknown',
        confirmLabel: 'Close',
      });
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    const closeButton = dialog.querySelector('[data-confirm-btn]') as HTMLButtonElement;
    expect(closeButton).toBe(document.activeElement);
    expect(closeButton.textContent).toBe('Close');
    await act(async () => closeButton.click());
    await expect(result).resolves.toBe(true);
  });

  it('cleans the singleton after dismissing an informational dialog with Escape', async () => {
    let first!: Promise<boolean>;
    await act(async () => {
      first = confirm({
        mode: 'info',
        title: 'Unknown',
        message: 'Unknown',
        confirmLabel: 'Close',
      });
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(first).resolves.toBe(false);

    let second!: Promise<boolean>;
    await act(async () => {
      second = confirm({ mode: 'info', title: 'Again', message: 'Again', confirmLabel: 'Close' });
    });
    await act(async () => (document.querySelector('[data-confirm-btn]') as HTMLButtonElement).click());
    await expect(second).resolves.toBe(true);
  });
});
