import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const stat = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return {
      isFile: () => true,
      size: Buffer.byteLength(data, 'utf8'),
    };
  });

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });
  const readFileSync = vi.fn((filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });
  const atomicWrite = vi.fn((filePath: string, data: string) => {
    files.set(norm(filePath), data);
  });
  const assertConsistent = vi.fn();
  return { files, stat, readFile, readFileSync, atomicWrite, assertConsistent };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: hoisted.readFileSync,
    promises: {
      ...actual.promises,
      stat: hoisted.stat,
      readFile: hoisted.readFile,
    },
  };
});

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

vi.mock('@main/utils/atomicWrite', () => ({
  atomicWriteSync: hoisted.atomicWrite,
}));

vi.mock('../../../../src/main/services/team/fileLock', () => ({
  withFileLockForSyncOperation: async (_path: string, operation: () => void) => operation(),
}));

vi.mock('../../../../src/main/services/team/TeamConfigReader', () => ({
  TeamConfigReader: class {
    async getRegistryBindingState() {
      return { status: 'verified', binding: {} };
    }
  },
}));

vi.mock('../../../../src/main/services/team/execution/ExecutionTaskStore', () => ({
  ExecutionTaskStore: class {
    list() {
      return [];
    }
  },
}));

vi.mock('agent-teams-controller', () => ({
  boardLocks: { tryWithTeamBoardLock: (_paths: unknown, operation: () => unknown) => operation() },
  createController: ({ teamName }: { teamName: string }) => ({
    kanban: {
      assertKanbanStateConsistent: hoisted.assertConsistent,
      getKanbanState: () => {
        const raw = hoisted.files.get(`/mock/teams/${teamName}/kanban-state.json`);
        const state = raw ? JSON.parse(raw) : { teamName, reviewers: [], tasks: {} };
        hoisted.assertConsistent(state);
        return state;
      },
      readKanbanStateAlreadyLocked: () => {
        const raw = hoisted.files.get(`/mock/teams/${teamName}/kanban-state.json`);
        const state = raw ? JSON.parse(raw) : { teamName, reviewers: [], tasks: {} };
        hoisted.assertConsistent(state);
        return state;
      },
    },
  }),
}));

import { TeamKanbanManager } from '../../../../src/main/services/team/TeamKanbanManager';

describe('TeamKanbanManager', () => {
  const manager = new TeamKanbanManager();
  const statePath = '/mock/teams/my-team/kanban-state.json';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
    hoisted.assertConsistent.mockReset();
  });

  it('returns default state on ENOENT', async () => {
    const result = await manager.getState('my-team');
    expect(result).toEqual({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    });
  });

  it('rejects corrupted JSON without replacing the board', async () => {
    hoisted.files.set(statePath, '{bad-json');
    await expect(manager.getState('my-team')).rejects.toThrow('corrupt');
    expect(hoisted.files.get(statePath)).toBe('{bad-json');
    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
  });

  it('writes review state with movedAt on set_column', async () => {
    await manager.updateTask('my-team', '12', { op: 'set_column', column: 'review' });
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, { column: string; movedAt: string }>;
    };

    expect(persisted.tasks?.['12']?.column).toBe('review');
    expect(typeof persisted.tasks?.['12']?.movedAt).toBe('string');
    expect(hoisted.atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('removes task state on remove', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.updateTask('my-team', '12', { op: 'remove' });
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, unknown>;
    };
    expect(persisted.tasks).toEqual({});
  });

  it('garbageCollect removes only stale tasks', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
          '13': { column: 'approved', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.garbageCollect('my-team', new Set(['12']));
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, unknown>;
    };
    expect(Object.keys(persisted.tasks ?? {})).toEqual(['12']);
  });

  it('garbageCollect does not write when nothing to remove', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.garbageCollect('my-team', new Set(['12']));
    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
  });
  it.each([
    '{bad',
    'null',
    '[]',
    '{"tasks":[]}',
    '{"teamName":"other","tasks":{}}',
    '{"tasks":{"t":{"column":"unknown","movedAt":"2026-01-01T00:00:00Z"}}}',
    '{"tasks":{"t":{"column":"review","movedAt":"invalid"}}}',
    '{"tasks":{},"reviewers":[null]}',
  ])('strict reads preserve invalid safety state instead of returning empty: %s', async (raw) => {
    hoisted.files.set(statePath, raw);
    await expect(manager.getState('my-team', { strict: true })).rejects.toThrow('corrupt');
    expect(hoisted.files.get(statePath)).toBe(raw);
    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
  });

  it('strict reads accept a missing board and valid legacy optional metadata', async () => {
    expect(await manager.getState('my-team', { strict: true })).toMatchObject({
      tasks: {},
      reviewers: [],
    });
    hoisted.files.set(
      statePath,
      JSON.stringify({ tasks: { t: { column: 'review', movedAt: '2026-01-01T00:00:00Z' } } })
    );
    expect(await manager.getState('my-team', { strict: true })).toMatchObject({
      tasks: { t: { column: 'review' } },
    });
  });

  it('propagates timeout for strict and ordinary reads', async () => {
    hoisted.files.set(statePath, '{"tasks":{}}');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    hoisted.readFile.mockRejectedValueOnce(abort);
    await expect(manager.getState('my-team', { strict: true })).rejects.toThrow('Timed out');
    hoisted.readFile.mockRejectedValueOnce(abort);
    await expect(manager.getState('my-team')).rejects.toThrow('Timed out');
  });

  it('strict reads reject disappearance after successful stat', async () => {
    hoisted.files.set(statePath, '{"tasks":{}}');
    hoisted.readFile.mockRejectedValueOnce(
      Object.assign(new Error('disappeared'), { code: 'ENOENT' })
    );
    await expect(manager.getState('my-team', { strict: true })).rejects.toThrow('disappeared');
  });

  it('strict reads reject oversized evidence without deleting it', async () => {
    const raw = ' '.repeat(512 * 1024 + 1);
    hoisted.files.set(statePath, raw);
    await expect(manager.getState('my-team', { strict: true })).rejects.toThrow('unavailable');
    expect(hoisted.files.get(statePath)).toBe(raw);
    expect(hoisted.readFile).not.toHaveBeenCalled();
  });
});
