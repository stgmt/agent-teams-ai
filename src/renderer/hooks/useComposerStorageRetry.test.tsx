import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useComposerStorageRetry } from './useComposerStorageRetry';

import type { ComposerDraftAddress } from '@renderer/types/composerDraft';

const retryPersistence = vi.hoisted(() => vi.fn());
vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: { retryPersistence },
}));
const address: ComposerDraftAddress = {
  contextId: 'TEST',
  teamName: 'TEST-team',
  target: { kind: 'direct', participant: 'alice' },
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  retryPersistence.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

describe('composer explicit storage retry control', () => {
  it('coalesces same-turn clicks and waits for the captured draft flush', async () => {
    const gate = deferred();
    const flush = vi.fn(() => gate.promise);
    retryPersistence.mockResolvedValue(true);
    let value!: ReturnType<typeof useComposerStorageRetry>;
    const Probe = (): null => {
      const retry = useComposerStorageRetry(address, flush);
      useLayoutEffect(() => {
        value = retry;
      });
      return null;
    };
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Probe />));
      let pending!: Promise<void>;
      act(() => {
        pending = value.retry();
        void value.retry();
      });
      expect(flush).toHaveBeenCalledOnce();
      expect(retryPersistence).not.toHaveBeenCalled();
      expect(value.retrying).toBe(true);
      await act(async () => {
        gate.resolve();
        await pending;
      });
      expect(retryPersistence).toHaveBeenCalledExactlyOnceWith('TEST', 'TEST-team');
      expect(value.retrying).toBe(false);
      expect(value.retryError).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not recover a previous chat after navigation while flushing', async () => {
    const gate = deferred();
    let currentAddress = address;
    let value!: ReturnType<typeof useComposerStorageRetry>;
    const Probe = (): null => {
      const retry = useComposerStorageRetry(currentAddress, () => gate.promise);
      useLayoutEffect(() => {
        value = retry;
      });
      return null;
    };
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Probe />));
      let pending!: Promise<void>;
      act(() => {
        pending = value.retry();
      });
      currentAddress = { ...address, target: { kind: 'direct', participant: 'bob' } };
      act(() => root.render(<Probe />));
      await act(async () => {
        gate.resolve();
        await pending;
      });
      expect(retryPersistence).not.toHaveBeenCalled();
      expect(value.retryError).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps a failed recovery visible only in the initiating chat', async () => {
    retryPersistence.mockResolvedValue(false);
    let currentAddress = address;
    let value!: ReturnType<typeof useComposerStorageRetry>;
    const Probe = (): null => {
      const retry = useComposerStorageRetry(currentAddress, () => Promise.resolve());
      useLayoutEffect(() => {
        value = retry;
      });
      return null;
    };
    const root = createRoot(document.createElement('div'));
    try {
      act(() => root.render(<Probe />));
      await act(async () => {
        await value.retry();
      });
      expect(value.retryError).toBe(true);
      currentAddress = { ...address, target: { kind: 'direct', participant: 'bob' } };
      act(() => root.render(<Probe />));
      expect(value.retryError).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
