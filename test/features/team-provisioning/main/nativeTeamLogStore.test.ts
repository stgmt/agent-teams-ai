// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NativeTeamLogStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamLogStore';

describe('native team log store', () => {
  it('reads newest-first windows for the latest run of a team', () => {
    const store = new NativeTeamLogStore();
    store.append('run-1', 'test-team', 'first', '2026-10-31T00:00:00.000Z');
    store.append('run-1', 'test-team', 'second', '2026-10-31T00:00:01.000Z');
    store.append('run-1', 'test-team', 'third', '2026-10-31T00:00:02.000Z');
    expect(store.read('test-team')).toMatchObject({
      lines: ['third', 'second', 'first'],
      total: 3,
      hasMore: false,
    });
    expect(store.read('test-team', { offset: 1, limit: 1 })).toMatchObject({
      lines: ['second'],
      total: 3,
      hasMore: true,
    });
    expect(store.read('test-absent')).toMatchObject({ lines: [], total: 0, hasMore: false });
  });

  it('caps the retained lines and clears a released run', () => {
    const store = new NativeTeamLogStore();
    for (let index = 0; index < 2_005; index += 1) {
      store.append('run-1', 'test-team', `line-${index}`);
    }
    expect(store.read('test-team').total).toBe(2_000);
    expect(store.read('test-team', { offset: 1_999, limit: 1 }).lines).toEqual(['line-5']);
    expect(store.read('test-team', { offset: 0, limit: 1 }).lines).toEqual(['line-2004']);
    store.clear('run-1');
    expect(store.read('test-team')).toMatchObject({ lines: [], total: 0, hasMore: false });
  });

  it('retains only the last run for a team after release', () => {
    const store = new NativeTeamLogStore();
    store.append('run-old', 'test-team', 'old', '2026-10-31T00:00:00.000Z');
    store.append('run-new', 'test-team', 'new', '2026-10-31T00:00:01.000Z');
    store.retainLast('test-team', 'run-new');
    expect(store.read('test-team').lines).toEqual(['new']);
    expect(store.read('test-team').total).toBe(1);
  });

  it('reads the newest run for the team', () => {
    const store = new NativeTeamLogStore();
    store.append('run-old', 'test-team', 'old', '2026-10-31T00:00:00.000Z');
    store.append('run-new', 'test-team', 'new', '2026-10-31T00:00:01.000Z');
    expect(store.read('test-team').lines).toEqual(['new']);
  });

  it('persists the last run across a restart and clears it on release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-logs-'));
    try {
      const store = new NativeTeamLogStore({ teamsRoot: root });
      store.append('run-1', 'test-team', 'first', '2026-10-31T00:00:00.000Z');
      store.append('run-1', 'test-team', 'second', '2026-10-31T00:00:01.000Z');
      store.retainLast('test-team', 'run-1');
      store.dispose();

      const reopened = new NativeTeamLogStore({ teamsRoot: root });
      expect(reopened.read('test-team')).toMatchObject({
        lines: ['second', 'first'],
        total: 2,
        hasMore: false,
      });

      reopened.clear('run-1');
      expect(new NativeTeamLogStore({ teamsRoot: root }).read('test-team')).toMatchObject({
        lines: [],
        total: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});
