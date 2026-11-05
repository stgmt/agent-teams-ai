import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useManualMessageQueue } from '../../../src/features/manual-message-queue/renderer/hooks/useManualMessageQueue';
import { ComposerStorageError } from '../../../src/renderer/services/composerDatabase';

import type { ManualQueueOptions } from '../../../src/features/manual-message-queue/renderer/hooks/useManualMessageQueue';

const ports = vi.hoisted(() => ({
  list: vi.fn(),
  reopen: vi.fn(),
  listener: null as null | (() => void),
}));
vi.mock('@features/localization/renderer', () => {
  const t = (key: string) => key;
  return { useAppTranslation: () => ({ t }) };
});
vi.mock('../../../src/features/manual-message-queue/renderer/ui/QueueList', () => ({
  QueueList: ({
    error,
    onRetryStorage,
  }: {
    error: string;
    onRetryStorage?: () => Promise<void>;
  }) => (
    <>
      {error}
      <button onClick={() => void onRetryStorage?.()}>Retry</button>
    </>
  ),
}));
vi.mock('../../../src/features/manual-message-queue/renderer/adapters/queueRepository', () => ({
  queueRepository: { list: ports.list, subscribe: () => vi.fn() },
}));
vi.mock('../../../src/features/manual-message-queue/renderer/adapters/queueBinding', () => ({
  captureQueueScope: () =>
    Promise.resolve({
      transport: 'desktop-local-teams-v1',
      root: 'TEST',
      contextId: 'local',
      host: null,
      teamName: 'TEST',
      chat: 'direct:alice',
    }),
}));
vi.mock('@renderer/services/composerDatabase', async (load) => {
  const actual = await load<typeof import('../../../src/renderer/services/composerDatabase')>();
  return {
    ...actual,
    composerDatabase: {
      reopen: ports.reopen,
      subscribe: (listener: () => void) => {
        ports.listener = listener;
        return () => {
          ports.listener = null;
        };
      },
    },
  };
});
vi.mock('@renderer/store', () => {
  const state = {
    activeContextId: 'local',
    isContextSwitching: false,
    connectedHost: null,
    appConfig: { general: { claudeRootPath: 'TEST' } },
  };
  return {
    useStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state,
    }),
  };
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ports.list.mockReset().mockResolvedValue([]);
  ports.reopen.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const options = (): ManualQueueOptions => ({
  teamName: 'TEST',
  route: { kind: 'direct', participant: 'alice' },
  text: 'Остаток\tЧто именно не завершено\nИсправить ошибку\tИсполнитель',
  unavailableReason: 'messages.manualQueue.unsupported.delegate',
  consume: vi.fn(),
  blockedReason: () => null,
  prepare: () => {
    throw new Error('TEST-unused');
  },
  transport: vi.fn(),
  refresh: () => Promise.resolve(),
});

describe('queue-only feedback', () => {
  it('explains Delegate only after an enqueue attempt and never consumes or sends the text', async () => {
    const input = options();
    let queue!: ReturnType<typeof useManualMessageQueue>;
    const Probe = (): React.JSX.Element => {
      const binding = useManualMessageQueue(input);
      useLayoutEffect(() => {
        queue = binding;
      });
      return <>{binding.list}</>;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<Probe />);
        await Promise.resolve();
      });
      expect(host.textContent).not.toContain('unsupported.delegate');
      act(() => queue.onEnqueue());
      expect(host.textContent).toContain('unsupported.delegate');
      expect(host.textContent).not.toContain('unsupported.command');
      expect(input.consume).not.toHaveBeenCalled();
      expect(input.transport).not.toHaveBeenCalled();
      input.unavailableReason = undefined;
      act(() => root.render(<Probe />));
      expect(host.textContent).not.toContain('unsupported.delegate');
    } finally {
      act(() => root.unmount());
    }
  });

  it('deduplicates storage feedback and reloads the queue after explicit reconnect without sending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = new ComposerStorageError(
      'open',
      new DOMException('Internal error.', 'UnknownError')
    );
    warn.mockClear();
    const input = { ...options(), storageNoticeVisible: true };
    ports.list.mockRejectedValue(failure);
    ports.reopen.mockImplementation(() => {
      ports.list.mockResolvedValue([]);
      ports.listener?.();
      return Promise.resolve();
    });
    let queue!: ReturnType<typeof useManualMessageQueue>;
    const Probe = (): React.JSX.Element => {
      const binding = useManualMessageQueue(input);
      useLayoutEffect(() => {
        queue = binding;
      });
      return <>{binding.list}</>;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<Probe />);
        await Promise.resolve();
      });
      expect(host.textContent).not.toContain('storageUnavailable');
      input.storageNoticeVisible = false;
      act(() => root.render(<Probe />));
      expect(host.textContent).toContain('storageUnavailable');
      expect(host.textContent).not.toContain('Internal error.');
      act(() => queue.onEnqueue());
      expect(host.textContent).toContain('storageUnavailable');
      expect(host.textContent).not.toContain('unsupported.delegate');
      await act(async () => {
        host.querySelector('button')!.click();
        await Promise.resolve();
      });
      expect(ports.reopen).toHaveBeenCalledOnce();
      expect(host.textContent).not.toContain('storageUnavailable');
      expect(input.transport).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      warn.mockRestore();
    }
  });
});
