import { afterEach, describe, expect, it, vi } from 'vitest';

const prefix = 'agent-teams:custom-template-pending-mutation:';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key);
  }
  vi.resetModules();
});

describe('pending template mutations', () => {
  it('records before dispatch and recovers the marker in a fresh renderer module', async () => {
    const first = await import('./pendingTemplateMutation');
    const operation = first.beginTemplateMutation({ kind: 'save', label: 'Team A' });
    expect(operation).not.toBeNull();
    expect(localStorage.getItem(prefix + operation!.id)).not.toBeNull();

    vi.resetModules();
    const restarted = await import('./pendingTemplateMutation');
    expect(restarted.getPendingTemplateMutations()).toEqual([operation]);
    expect(restarted.beginTemplateMutation({ kind: 'delete', label: 'Team A' })).toBeNull();
  });

  it('retains separate concurrent markers received from another window', async () => {
    const store = await import('./pendingTemplateMutation');
    const first = store.beginTemplateMutation({ kind: 'duplicate', label: 'One' });
    localStorage.setItem(prefix + 'other-window', JSON.stringify({ kind: 'delete', label: 'Two' }));
    window.dispatchEvent(new StorageEvent('storage', { key: prefix + 'other-window' }));
    expect(store.getPendingTemplateMutations().map(({ label }) => label)).toEqual(['One', 'Two']);
    store.finishTemplateMutation(first!);
    expect(store.getPendingTemplateMutations().map(({ label }) => label)).toEqual(['Two']);
  });

  it('refuses to start when the recovery marker cannot be written', async () => {
    const store = await import('./pendingTemplateMutation');
    const realStorage = localStorage;
    vi.stubGlobal('localStorage', {
      get length() {
        return realStorage.length;
      },
      key: realStorage.key.bind(realStorage),
      getItem: realStorage.getItem.bind(realStorage),
      removeItem: realStorage.removeItem.bind(realStorage),
      setItem: () => {
        throw new Error('storage denied');
      },
    });
    expect(store.beginTemplateMutation({ kind: 'save', label: 'Team A' })).toBeNull();
    expect(store.getPendingTemplateMutations()).toEqual([]);
  });
});
