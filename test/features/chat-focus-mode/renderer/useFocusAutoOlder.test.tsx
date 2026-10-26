import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  FOCUS_AUTO_OLDER_FAILURE_CAP,
  FOCUS_AUTO_OLDER_PAGE_CAP,
  FOCUS_AUTO_OLDER_START_TIMEOUT_MS,
  useFocusAutoOlder,
} from '@features/chat-focus-mode/renderer/hooks/useFocusAutoOlder';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Props = Parameters<typeof useFocusAutoOlder>[0];

let searching = false;
const Probe = (props: Props): null => {
  searching = useFocusAutoOlder(props);
  return null;
};

let root: Root | null = null;

async function render(props: Props): Promise<void> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  if (!root) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const current = root;
  await act(async () => {
    current.render(React.createElement(Probe, props));
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('useFocusAutoOlder', () => {
  it('loads one page at a time until a request shows up', async () => {
    const onLoadOlder = vi.fn();
    const base = { hasRequest: false, hasMore: true, onLoadOlder };
    await render({ ...base, loadingOlder: false });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(searching).toBe(true);

    // Re-renders before the load starts (e.g. live messages at the head) do not request again.
    await render({ ...base, loadingOlder: false });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    await render({ ...base, loadingOlder: true });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    await render({ ...base, loadingOlder: false });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);

    await render({ ...base, loadingOlder: true });
    await render({ ...base, hasRequest: true, loadingOlder: false });
    expect(onLoadOlder).toHaveBeenCalledTimes(2);
    expect(searching).toBe(false);
  });

  it('does nothing when there is no older history', async () => {
    const onLoadOlder = vi.fn();
    await render({
      hasRequest: false,
      hasMore: false,
      loadingOlder: false,
      onLoadOlder,
    });
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(searching).toBe(false);
  });

  it('retries a load the store skipped, then gives up after repeated failures', async () => {
    vi.useFakeTimers();
    const onLoadOlder = vi.fn();
    const props = {
      hasRequest: false,
      hasMore: true,
      loadingOlder: false,
      onLoadOlder,
    };
    await render(props);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    for (let attempt = 1; attempt < FOCUS_AUTO_OLDER_FAILURE_CAP; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FOCUS_AUTO_OLDER_START_TIMEOUT_MS);
      });
      expect(onLoadOlder).toHaveBeenCalledTimes(attempt + 1);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FOCUS_AUTO_OLDER_START_TIMEOUT_MS * 3);
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(FOCUS_AUTO_OLDER_FAILURE_CAP);
    expect(searching).toBe(false);
  });

  it('counts every load that ran toward the page cap, even with nothing for this chat', async () => {
    const onLoadOlder = vi.fn();
    const base = { hasRequest: false, hasMore: true, onLoadOlder };
    for (let page = 1; page <= FOCUS_AUTO_OLDER_PAGE_CAP + 2; page += 1) {
      await render({ ...base, loadingOlder: false });
      await render({ ...base, loadingOlder: true });
    }
    await render({ ...base, loadingOlder: false });
    expect(onLoadOlder).toHaveBeenCalledTimes(FOCUS_AUTO_OLDER_PAGE_CAP);
    expect(searching).toBe(false);
  });

  it('treats a page the store discarded as a failure, not a page', async () => {
    const onLoadOlder = vi.fn();
    const base = { hasRequest: false, hasMore: true, onLoadOlder };
    for (let attempt = 1; attempt <= FOCUS_AUTO_OLDER_FAILURE_CAP + 2; attempt += 1) {
      await render({ ...base, loadingOlder: true, historyDiscarded: false });
      await render({ ...base, loadingOlder: false, historyDiscarded: true });
    }
    expect(onLoadOlder).toHaveBeenCalledTimes(FOCUS_AUTO_OLDER_FAILURE_CAP);
    expect(searching).toBe(false);
  });
});
