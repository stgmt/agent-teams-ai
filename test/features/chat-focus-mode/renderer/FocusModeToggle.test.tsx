import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { FocusModeToggle } from '@features/chat-focus-mode/renderer/ui/FocusModeToggle';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function renderToggle(props: React.ComponentProps<typeof FocusModeToggle>): Promise<{
  host: HTMLElement;
  unmount: () => void;
}> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(FocusModeToggle, props));
    await Promise.resolve();
  });
  return { host, unmount: () => act(() => root.unmount()) };
}

function pressAltF(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', altKey: true }));
}

describe('FocusModeToggle', () => {
  it('toggles on click and shows the unanswered counter only when active', async () => {
    const onToggle = vi.fn();
    const onJumpToPending = vi.fn();
    const { host } = await renderToggle({
      active: true,
      pendingCount: 2,
      onToggle,
      onJumpToPending,
    });
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="messages.focus.toggle"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    const counter = host.querySelector<HTMLButtonElement>(
      '[aria-label="messages.focus.pending:2"]'
    );
    expect(counter?.textContent).toBe('2');
    act(() => {
      counter?.click();
      toggle?.click();
    });
    expect(onJumpToPending).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('hides the counter in the normal view', async () => {
    const { host } = await renderToggle({
      active: false,
      pendingCount: 3,
      onToggle: vi.fn(),
      onJumpToPending: vi.fn(),
    });
    expect(host.textContent).not.toContain('messages.focus.pending');
  });

  it('toggles on Alt+F only while the button is visible', async () => {
    const onToggle = vi.fn();
    const { unmount } = await renderToggle({
      active: false,
      pendingCount: 0,
      onToggle,
      onJumpToPending: vi.fn(),
    });
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects');
    rects.mockReturnValue([] as unknown as DOMRectList);
    pressAltF();
    expect(onToggle).not.toHaveBeenCalled();

    rects.mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
    pressAltF();
    expect(onToggle).toHaveBeenCalledTimes(1);

    unmount();
    pressAltF();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
