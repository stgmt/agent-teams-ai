import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskActivityIntervalService } from '../../../../src/main/services/team/TeamTaskActivityIntervalService';
import { ExecutionTaskStore } from '../../../../src/main/services/team/execution/ExecutionTaskStore';
import type { TeamTask } from '../../../../src/shared/types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(tasks: Partial<TeamTask>[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-registry-'));
  roots.push(root);
  const store = new ExecutionTaskStore({ basePath: root });
  const reader = { getTasks: vi.fn(async () => tasks as TeamTask[]) };
  return { store, reader, service: new TeamTaskActivityIntervalService(reader, store) };
}

describe('TeamTaskActivityIntervalService', () => {
  it('serializes resume and pause and stores only execution data', async () => {
    const { store, reader, service } = setup([{ id: '1', status: 'in_progress', owner: 'builder', subject: 'Build' }]);
    const resume = service.resumeActiveIntervalsForMember('sandbox', 'builder', '2026-01-01T10:00:00.000Z');
    const pause = service.pauseActiveIntervalsForMember('sandbox', 'builder', '2026-01-01T10:01:00.000Z');
    expect(await resume).toEqual({ changedTasks: 1 });
    expect(await pause).toEqual({ changedTasks: 1 });
    expect(reader.getTasks).toHaveBeenCalledTimes(2);
    expect(store.read('sandbox', '1')?.workIntervals).toEqual([{ startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T10:01:00.000Z' }]);
    expect(store.read('sandbox', '1')).not.toHaveProperty('status');
    expect(store.read('sandbox', '1')).not.toHaveProperty('subject');
  });

  it('pauses only the selected member work and review intervals', async () => {
    const { store, service } = setup([
      { id: '1', status: 'in_progress', owner: 'bob', subject: 'A' },
      { id: '2', status: 'in_progress', owner: 'tom', subject: 'B' },
    ]);
    store.write('sandbox', '1', { workIntervals: [{ startedAt: '2026-01-01T10:00:00.000Z' }], reviewIntervals: [{ reviewer: 'alice', startedAt: '2026-01-01T10:00:00.000Z' }] });
    store.write('sandbox', '2', { workIntervals: [{ startedAt: '2026-01-01T10:00:00.000Z' }], reviewIntervals: [{ reviewer: 'bob', startedAt: '2026-01-01T10:00:00.000Z' }] });
    expect(await service.pauseActiveIntervalsForMember('sandbox', 'bob', '2026-01-01T10:01:00.000Z')).toEqual({ changedTasks: 2 });
    expect(store.read('sandbox', '1')?.workIntervals[0].completedAt).toBe('2026-01-01T10:01:00.000Z');
    expect(store.read('sandbox', '1')?.reviewIntervals[0].completedAt).toBeUndefined();
    expect(store.read('sandbox', '2')?.workIntervals[0].completedAt).toBeUndefined();
    expect(store.read('sandbox', '2')?.reviewIntervals[0].completedAt).toBe('2026-01-01T10:01:00.000Z');
  });

  it('resumes a batch idempotently and observes changed registry owners on later calls', async () => {
    const tasks: Partial<TeamTask>[] = [{ id: '1', status: 'in_progress', owner: 'bob' }, { id: '2', status: 'in_progress', owner: 'tom' }];
    const { store, service } = setup(tasks);
    expect(await service.resumeActiveIntervalsForMembers('sandbox', ['bob', 'tom'], '2026-01-01T10:00:00.000Z')).toEqual({ changedTasks: 2 });
    expect(await service.resumeActiveIntervalsForMembers('sandbox', ['bob', 'tom'], '2026-01-01T10:00:01.000Z')).toEqual({ changedTasks: 0 });
    await service.pauseActiveIntervalsForMember('sandbox', 'bob', '2026-01-01T10:01:00.000Z');
    tasks[0].owner = 'alice';
    expect(await service.resumeActiveIntervalsForMember('sandbox', 'alice', '2026-01-01T10:02:00.000Z')).toEqual({ changedTasks: 1 });
    expect(store.read('sandbox', '1')?.workIntervals).toHaveLength(2);
  });

  it('materializes a closed work interval from execution history on pause', async () => {
    const { store, service } = setup([{ id: '1', status: 'in_progress', owner: 'bob' }]);
    store.appendHistoryEvent('sandbox', '1', { id: 'start', type: 'status_changed', from: 'pending', to: 'in_progress', timestamp: '2026-01-01T10:00:00.000Z' });
    expect(await service.pauseActiveIntervalsForTeam('sandbox', '2026-01-01T10:01:00.000Z')).toEqual({ changedTasks: 1 });
    expect(store.read('sandbox', '1')?.workIntervals).toEqual([{ startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T10:01:00.000Z' }]);
  });

  it('repairs stale open intervals with crash grace and does not repair twice', async () => {
    const { store, service } = setup([{ id: '1', status: 'in_progress', owner: 'bob' }]);
    store.write('sandbox', '1', { workIntervals: [{ startedAt: '2026-01-01T10:00:00.000Z' }] });
    expect(await service.repairStaleIntervalsAfterCrash('sandbox')).toEqual({ changedTasks: 1 });
    expect(store.read('sandbox', '1')?.workIntervals).toEqual([{ startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T10:00:05.000Z' }]);
    expect(await service.repairStaleIntervalsAfterCrash('sandbox')).toEqual({ changedTasks: 0 });
  });

  it('reports registry errors without creating execution records', async () => {
    const { store, reader, service } = setup([{ id: '1', status: 'in_progress' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reader.getTasks.mockRejectedValueOnce(new Error('registry unavailable'));
    expect(await service.pauseActiveIntervalsForTeam('sandbox')).toEqual({ changedTasks: 0, failed: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(store.list('sandbox')).toEqual([]);
  });
});
