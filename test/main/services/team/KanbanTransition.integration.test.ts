import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { createController } from 'agent-teams-controller';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('agent-teams-controller', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../../../../agent-teams-controller/src/index.js');
});
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => path.join(fixture.dir, 'teams'),
  getTasksBasePath: () => path.join(fixture.dir, 'tasks'),
  getLocalTasksBasePath: () => path.join(fixture.dir, 'tasks-local'),
}));

import { ExecutionTaskStore } from '@main/services/team/execution/ExecutionTaskStore';
import { withFileLockForSyncOperation } from '@main/services/team/fileLock';
import { stopTeamWithEscalation } from '@main/services/team/lifecycle/teamForceStopFlow';
import { stopTeamFlow } from '@main/services/team/provisioning/TeamProvisioningStopFlow';
import { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import * as teamAtomicWrite from '@main/services/team/atomicWrite';
import * as atomicWrite from '@main/utils/atomicWrite';
import { runTeamStopAction } from '@renderer/components/team/teamStopAction';

describe('Kanban transition integration', () => {
  let teamDir: string;
  beforeEach(() => {
    fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-tx-test-'));
    teamDir = path.join(fixture.dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
  });
  afterEach(() => {
    const target = path.resolve(fixture.dir);
    if (
      !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(target).startsWith('kanban-tx-test-')
    ) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  /**
   * Registry authority is published by the canonical metadata scope; config.json
   * carries no specification fields any more, and the legacy keys are refused.
   */
  function writeRegistryScope(): void {
    fs.writeFileSync(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: fixture.dir,
        specScope: {
          projects: ['owner/project'],
          bindings: [{ project: 'owner/project', spec: 'spec' }],
        },
      })
    );
  }

  it('reads a local board using the explicitly local task backend', async () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    controller.taskBoard.createTask({ subject: 'Local task' });
    await expect(
      new TeamKanbanManager().getState('fixture', { strict: true })
    ).resolves.toMatchObject({
      teamName: 'fixture',
      tasks: {},
    });
  });

  it('reads a registry draft from its metadata without contacting the registry', async () => {
    fs.unlinkSync(path.join(teamDir, 'config.json'));
    writeRegistryScope();
    await expect(
      new TeamKanbanManager().getState('fixture', { strict: true })
    ).resolves.toMatchObject({
      teamName: 'fixture',
      tasks: {},
    });
  });

  it('surfaces unreadable execution records instead of returning an empty board', async () => {
    const executionDir = path.join(fixture.dir, 'tasks-local', 'fixture');
    fs.mkdirSync(executionDir, { recursive: true });
    fs.writeFileSync(path.join(executionDir, 'broken.json'), '{');
    await expect(new TeamKanbanManager().getState('fixture', { strict: true })).rejects.toThrow(
      /Execution record/
    );
  });

  it('does not substitute an empty board when the board file is corrupt', async () => {
    fs.writeFileSync(path.join(teamDir, 'kanban-state.json'), '{');
    await expect(new TeamKanbanManager().getState('fixture')).rejects.toThrow(
      /Kanban safety state is corrupt/
    );
  });

  it('reads registry boards without consulting local canonical task files', async () => {
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'fixture', members: [] })
    );
    writeRegistryScope();
    const tasksDir = path.join(fixture.dir, 'tasks', 'fixture');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(tasksDir, 'stale.json'),
      JSON.stringify({ id: 'stale', status: 'deleted', pendingKanbanTransition: null })
    );
    await expect(
      new TeamKanbanManager().getState('fixture', { strict: true })
    ).resolves.toMatchObject({
      teamName: 'fixture',
      tasks: {},
    });
  });

  it('updates registry board ordering while preserving existing task entries', async () => {
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'fixture', members: [] })
    );
    writeRegistryScope();
    const statePath = path.join(teamDir, 'kanban-state.json');
    const task = { column: 'review', movedAt: '2026-01-01T00:00:00.000Z', reviewer: 'lead' };
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        teamName: 'fixture',
        reviewers: ['lead'],
        tasks: { 'spec:TASK-1': task },
      })
    );
    await new TeamKanbanManager().updateColumnOrder('fixture', 'review', ['spec:TASK-1']);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({
      reviewers: ['lead'],
      tasks: { 'spec:TASK-1': task },
      columnOrder: { review: ['spec:TASK-1'] },
    });
  });

  it('blocks a registry board for an execution marker even without a canonical task', async () => {
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'fixture', members: [] })
    );
    writeRegistryScope();
    const taskId = 'orphan-task';
    const hash = 'a'.repeat(64);
    new ExecutionTaskStore().write('fixture', taskId, {
      pendingKanbanTransition: {
        id: 'transition',
        taskId,
        kind: 'review',
        phase: 'prepared',
        column: 'review',
        beforeTaskHash: hash,
        expectedTaskHash: hash,
        beforeBoardHash: hash,
        expectedBoardHash: hash,
        beforeBoardToken: hash,
        contextHash: hash,
        targetBoard: { teamName: 'fixture', reviewers: [], tasks: {} },
      },
    });
    await expect(
      new TeamKanbanManager().getState('fixture', { strict: true })
    ).rejects.toMatchObject({
      code: 'KANBAN_TRANSITION_UNCERTAIN',
      taskId,
    });
    await expect(
      new TeamKanbanManager().updateColumnOrder('fixture', 'review', [taskId])
    ).rejects.toMatchObject({ code: 'KANBAN_TRANSITION_UNCERTAIN', taskId });
    expect(fs.existsSync(path.join(teamDir, 'kanban-state.json'))).toBe(false);
  });

  it('does not fall back to local tasks for an invalid registry binding', async () => {
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({ name: 'fixture', members: [], specProject: 'owner/project' })
    );
    await expect(new TeamKanbanManager().getState('fixture', { strict: true })).rejects.toThrow(
      /Cannot verify task authority/
    );
  });

  it('exposes a failed board publication as uncertain to the controller, desktop and a restarted process', async () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = controller.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      completeTask: (id: string, actor: string) => void;
      requestReview: (id: string, options: object) => void;
      getKanbanState: () => unknown;
    };
    const task = board.createTask({ subject: 'fixture', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    controller.taskBoard.addReviewer('lead');
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const original = rawFs.writeFileSync;
    const write = vi.spyOn(rawFs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (
        typeof target === 'string' &&
        path.dirname(target) === teamDir &&
        path.basename(target).startsWith('.tmp.')
      ) {
        throw Object.assign(new Error('board EIO'), { code: 'EIO' });
      }
      return (original as (...parts: unknown[]) => void)(target, ...args);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => board.requestReview(task.id, { from: 'worker', reviewer: 'lead' })).toThrow(
        /may have completed/
      );
    } finally {
      write.mockRestore();
    }
    expect(() => board.getKanbanState()).toThrow(/unknown outcome/);
    const manager = new TeamKanbanManager();
    await expect(manager.getState('fixture')).rejects.toMatchObject({
      code: 'KANBAN_TRANSITION_UNCERTAIN',
    });
    const stat = rawFs.promises.stat;
    const statSpy = vi.spyOn(rawFs.promises, 'stat').mockImplementation(((
      candidate: fs.PathLike,
      ...args: unknown[]
    ) => {
      if (path.resolve(String(candidate)) === path.join(teamDir, 'kanban-state.json')) {
        throw Object.assign(new Error('board stat EIO'), { code: 'EIO' });
      }
      return (stat as (...parts: unknown[]) => unknown)(candidate, ...args);
    }) as typeof rawFs.promises.stat);
    try {
      await expect(manager.getState('fixture')).rejects.toMatchObject({
        code: 'KANBAN_TRANSITION_UNCERTAIN',
      });
    } finally {
      statSpy.mockRestore();
    }
    await expect(manager.updateColumnOrder('fixture', 'review', [task.id])).rejects.toMatchObject({
      code: 'KANBAN_TRANSITION_UNCERTAIN',
    });
    const source = path.resolve('agent-teams-controller/src/index.js');
    const child = `const {createController}=require(process.argv[1]); try { createController({teamName:'fixture',claudeDir:process.argv[2],localTaskBoard:true}).taskBoard.getKanbanState(); process.exitCode=1; } catch(e) { if(e.code !== 'KANBAN_TRANSITION_UNCERTAIN') { console.error(e); process.exitCode=2; } }`;
    execFileSync(process.execPath, ['-e', child, source, fixture.dir]);
  });

  it('waits asynchronously for the controller lock before a synchronous board write', async () => {
    const liveController = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = liveController.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      completeTask: (id: string, actor: string) => void;
    };
    const messages = liveController.messages as unknown as {
      sendMessage: (input: object) => { deduplicated?: boolean };
    };
    const task = board.createTask({ subject: 'Write the summary', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    messages.sendMessage({ to: 'user', from: 'lead', text: 'The summary is finished.' });
    const inboxPath = path.join(teamDir, 'inboxes', 'user.json');
    const beforeInbox = fs.readFileSync(inboxPath, 'utf8');
    const lockModule = path.resolve('agent-teams-controller/src/internal/fileLock.js');
    const lockScope = path.join(teamDir, 'board-state');
    const source = `require(process.argv[1]).withFileLockSync(process.argv[2], () => { process.stdout.write('locked\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); });`;
    const child = spawn(process.execPath, ['-e', source, lockModule, lockScope], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`lock fixture exited ${code}`));
      });
    });
    const { readBoardCompletionEpoch } = createRequire(import.meta.url)(
      '../../../../agent-teams-controller/src/internal/messageStore.js'
    ) as { readBoardCompletionEpoch: (paths: object) => unknown };
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    }) as unknown as { context: { paths: object } };
    const started = Date.now();
    expect(() => readBoardCompletionEpoch(controller.context.paths)).toThrow(
      /message was not sent/
    );
    expect(() =>
      messages.sendMessage({ to: 'user', from: 'lead', text: 'Everything is done.' })
    ).toThrow(/message was not sent/);
    expect(fs.readFileSync(inboxPath, 'utf8')).toBe(beforeInbox);
    expect(Date.now() - started).toBeLessThan(800);
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 20);
    await new TeamKanbanManager().updateColumnOrder('fixture', 'review', ['task-1']);
    expect(fs.readFileSync(inboxPath, 'utf8')).toBe(beforeInbox);
    clearTimeout(timer);
    expect(timerRan).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(teamDir, 'kanban-state.json'), 'utf8'));
    expect(saved.columnOrder.review).toEqual(['task-1']);
  });

  it('does not alter a pending review while repairing stale activity after a crash', () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = controller.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      completeTask: (id: string, actor: string) => void;
      requestReview: (id: string, options: object) => void;
      startReview: (id: string, options: object) => void;
      startTask: (id: string, actor: string) => void;
    };
    const task = board.createTask({ subject: 'fixture', owner: 'worker' });
    const other = board.createTask({ subject: 'other task', owner: 'worker' });
    board.startTask(other.id, 'worker');
    board.completeTask(task.id, 'worker');
    board.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const original = rawFs.writeFileSync;
    const spy = vi.spyOn(rawFs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (
        typeof target === 'string' &&
        path.dirname(target) === teamDir &&
        path.basename(target).startsWith('.tmp.')
      ) {
        throw Object.assign(new Error('board EIO'), { code: 'EIO' });
      }
      return (original as (...parts: unknown[]) => void)(target, ...args);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => board.startReview(task.id, { from: 'lead' })).toThrow(/unknown outcome/);
    } finally {
      spy.mockRestore();
    }
    expect((controller.kanban.inspectPendingTransition(task.id) as { mode: string }).mode).toBe(
      'publish'
    );
    const taskPath = path.join(fixture.dir, 'tasks', 'fixture', `${task.id}.json`);
    const before = fs.readFileSync(taskPath, 'utf8');
    const repaired = new TeamTaskActivityIntervalService().repairStaleIntervalsAfterCrash(
      'fixture'
    );
    expect(repaired.changedTasks).toBe(1);
    expect(fs.readFileSync(taskPath, 'utf8')).toBe(before);
    expect((controller.kanban.inspectPendingTransition(task.id) as { mode: string }).mode).toBe(
      'publish'
    );
  });

  it('reports an unfinished timer without changing an uncertain review, and preserves explicit recovery', async () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = controller.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      completeTask: (id: string, actor: string) => void;
      requestReview: (id: string, options: object) => void;
      startReview: (id: string, options: object) => void;
    };
    const task = board.createTask({ subject: 'review clock', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    controller.taskBoard.addReviewer('lead');
    board.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const rename = rawFs.renameSync;
    const spy = vi.spyOn(rawFs, 'renameSync').mockImplementation(((source, destination) => {
      if (String(destination).endsWith('kanban-state.json')) {
        throw Object.assign(new Error('board publication EIO'), { code: 'EIO' });
      }
      return rename(source, destination);
    }) as typeof rawFs.renameSync);
    try {
      expect(() => board.startReview(task.id, { from: 'lead' })).toThrow(/unknown outcome/i);
    } finally {
      spy.mockRestore();
    }
    const taskPath = path.join(fixture.dir, 'tasks', 'fixture', `${task.id}.json`);
    const before = fs.readFileSync(taskPath, 'utf8');
    const parsed = JSON.parse(before);
    expect(parsed.pendingKanbanTransition.beforeTaskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.pendingKanbanTransition.expectedTaskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.reviewIntervals.at(-1).completedAt).toBeUndefined();
    const inspected = controller.kanban.inspectPendingTransition(task.id);
    expect(inspected.mode).toBe('publish');
    if (inspected.mode === 'conflict') {
      throw new Error(
        'The pending transition cannot be resolved while its board snapshot conflicts.'
      );
    }
    const activity = new TeamTaskActivityIntervalService();
    const pause = vi.fn(() =>
      activity.pauseActiveIntervalsForTeam('fixture', '2026-11-06T00:00:00.000Z')
    );
    const stopProcesses = vi.fn();
    const ports = {
      cancelOpenCodePromptDeliveries: vi.fn().mockResolvedValue(undefined),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      pauseActiveIntervalsForTeam: pause,
      stopPersistentTeamMembers: stopProcesses,
      openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
      getTrackedRunId: () => null,
      hasSecondaryRuntimeRuns: () => false,
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn() },
    };
    const kill = vi.fn();
    const cancelDeliveries = vi.fn();
    const reportFailure = vi.fn();
    const logError = vi.fn();
    const processAlive = vi.fn();
    const outcome = await runTeamStopAction({
      teamName: 'fixture',
      stop: async () => {
        await stopTeamWithEscalation('fixture', {
          stopTeam: () => stopTeamFlow('fixture', ports as never),
          observeOwnedRuntimeRunIds: async () => [],
          killRetainedRuntimeProcesses: kill,
          clearPendingPromptDeliveries: cancelDeliveries,
          logWarning: vi.fn(),
        });
      },
      processAlive,
      refresh: vi.fn().mockResolvedValue(undefined),
      setBusy: vi.fn(),
      reportFailure,
      logError,
      logRefreshError: vi.fn(),
    });
    expect(outcome).toBe('stopped_activity_review_pending');
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'task_activity_interval_pause_failed_after_stop',
        pendingTransition: true,
      })
    );
    expect(processAlive).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(cancelDeliveries).not.toHaveBeenCalled();
    expect(stopProcesses).toHaveBeenCalledTimes(1);
    // The clock is paused at both dedicated boundaries: before teardown, and
    // again at the final persisted boundary after every owned stop settled.
    // Both attempts are blocked by the same uncertain review, so both report
    // the pending transition and neither rewrites the task.
    expect(pause).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(taskPath, 'utf8')).toBe(before);
    expect(controller.kanban.inspectPendingTransition(task.id)).toEqual(inspected);
    controller.kanban.resolvePendingTransition(
      task.id,
      inspected.transitionId,
      inspected.snapshotHash,
      inspected.mode,
      inspected.contextHash
    );
    const resolved = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    expect(resolved.pendingKanbanTransition).toBeUndefined();
    expect(resolved.historyEvents).toEqual(parsed.historyEvents);
    expect(
      activity.pauseActiveIntervalsForTeam('fixture', '2026-11-06T00:00:00.000Z').changedTasks
    ).toBe(1);
    const stopped = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    expect(stopped.reviewIntervals.at(-1).completedAt).toBeTruthy();
    expect(stopped.historyEvents).toEqual(parsed.historyEvents);
  });

  it('does not retry an activity write whose rename succeeded before reporting EIO', async () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = controller.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      startTask: (id: string, actor: string) => void;
    };
    const task = board.createTask({ subject: 'work clock', owner: 'worker' });
    board.startTask(task.id, 'worker');
    const taskPath = path.join(fixture.dir, 'tasks', 'fixture', `${task.id}.json`);
    const write = atomicWrite.atomicWriteSync;
    let attempts = 0;
    const spy = vi
      .spyOn(atomicWrite, 'atomicWriteSync')
      .mockImplementation((target, data, options) => {
        write(target, data, options);
        if (path.resolve(String(target)) === taskPath) {
          attempts += 1;
          throw Object.assign(new Error('rename completed but reported EIO'), { code: 'EIO' });
        }
      });
    const activity = new TeamTaskActivityIntervalService();
    const pause = vi.fn(() => activity.pauseActiveIntervalsForTeam('fixture'));
    const stopProcesses = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    const ports = {
      cancelOpenCodePromptDeliveries: vi.fn().mockResolvedValue(undefined),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      pauseActiveIntervalsForTeam: pause,
      stopPersistentTeamMembers: stopProcesses,
      openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
      getTrackedRunId: () => null,
      hasSecondaryRuntimeRuns: () => false,
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn() },
    };
    try {
      // The pre-teardown pause wrote the interval and then reported EIO. The
      // final boundary re-reads the already-closed interval and settles the
      // clock, so the stop confirms instead of failing — but the write itself
      // is never retried, which `attempts` proves below.
      await expect(stopTeamFlow('fixture', ports as never)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(stopProcesses).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(attempts).toBe(1);
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('rename completed but reported EIO')
    );
    expect(
      JSON.parse(fs.readFileSync(taskPath, 'utf8')).workIntervals.at(-1).completedAt
    ).toBeTruthy();
  });

  it('does not close an uncertain interval after another process publishes a new run', async () => {
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    const board = controller.taskBoard as unknown as {
      createTask: (input: object) => { id: string };
      completeTask: (id: string, actor: string) => void;
      requestReview: (id: string, options: object) => void;
      startReview: (id: string, options: object) => void;
    };
    const task = board.createTask({ subject: 'new run race', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    board.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const rename = rawFs.renameSync;
    const spy = vi.spyOn(rawFs, 'renameSync').mockImplementation(((source, destination) => {
      if (String(destination).endsWith('kanban-state.json')) {
        throw Object.assign(new Error('board publication EIO'), { code: 'EIO' });
      }
      return rename(source, destination);
    }) as typeof rawFs.renameSync);
    try {
      expect(() => board.startReview(task.id, { from: 'lead' })).toThrow(/unknown outcome/i);
    } finally {
      spy.mockRestore();
    }
    const taskPath = path.join(fixture.dir, 'tasks', 'fixture', `${task.id}.json`);
    const before = fs.readFileSync(taskPath, 'utf8');
    const configPath = path.join(fixture.dir, 'child-tsconfig.json');
    const shimPath = path.join(fixture.dir, 'child-controller.mjs');
    fs.writeFileSync(
      shimPath,
      `import { createRequire } from 'node:module';
const controller = createRequire(import.meta.url)(${JSON.stringify(path.resolve('agent-teams-controller/src/index.js'))});
export const boardLocks = controller.boardLocks;`
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'bundler',
          paths: {
            '@features/*': [path.resolve('src/features/*')],
            '@main/*': [path.resolve('src/main/*')],
            '@shared/*': [path.resolve('src/shared/*')],
            '@claude-teams/agent-graph': [path.resolve('packages/agent-graph/src/index.ts')],
            'agent-teams-controller': [shimPath],
          },
        },
      })
    );
    const output = execFileSync(
      process.execPath,
      [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        '--tsconfig',
        configPath,
        path.resolve('test/main/services/team/fixtures/activityLaunchChild.ts'),
        fixture.dir,
      ],
      { encoding: 'utf8' }
    );
    expect(JSON.parse(output)).toMatchObject({ published: true, result: { changedTasks: 0 } });
    const activity = new TeamTaskActivityIntervalService();
    const pause = vi.fn(() => activity.pauseActiveIntervalsForTeam('fixture'));
    const ports = {
      cancelOpenCodePromptDeliveries: vi.fn().mockResolvedValue(undefined),
      invalidateRuntimeSnapshotCaches: vi.fn(),
      pauseActiveIntervalsForTeam: pause,
      stopPersistentTeamMembers: vi.fn(),
      openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
      getTrackedRunId: () => null,
      hasSecondaryRuntimeRuns: () => false,
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: vi.fn().mockResolvedValue(undefined),
      logger: { info: vi.fn() },
    };
    await expect(stopTeamFlow('fixture', ports as never)).rejects.toMatchObject({
      code: 'task_activity_interval_pause_failed_after_stop',
      pendingTransition: true,
    });
    // Pre-teardown and final boundary both stay blocked by the transition the
    // other process left behind, so neither closes the uncertain interval.
    expect(pause).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(taskPath, 'utf8')).toBe(before);
  });

  it('does not overwrite another process launching during stop publication', async () => {
    const store = new TeamLaunchStateStore();
    expect(await store.beginLaunch('fixture', 'old-run', ['lead'], () => true)).toBe(true);
    const authority = await store.beginStop('fixture');
    const alias = path.join(fixture.dir, 'root-junction');
    fs.symlinkSync(fixture.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const ready = path.join(fixture.dir, 'launch-child-ready');
    const done = path.join(fixture.dir, 'launch-child-done');
    const shim = path.join(fixture.dir, 'launch-controller.mjs');
    const config = path.join(fixture.dir, 'launch-child-tsconfig.json');
    fs.writeFileSync(
      shim,
      `import { createRequire } from 'node:module';
const controller = createRequire(import.meta.url)(${JSON.stringify(path.resolve('agent-teams-controller/src/index.js'))});
export const boardLocks = controller.boardLocks;`
    );
    fs.writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'bundler',
          paths: {
            '@features/*': [path.resolve('src/features/*')],
            '@main/*': [path.resolve('src/main/*')],
            '@shared/*': [path.resolve('src/shared/*')],
            '@claude-teams/agent-graph': [path.resolve('packages/agent-graph/src/index.ts')],
            'agent-teams-controller': [shim],
          },
        },
      })
    );
    const write = teamAtomicWrite.atomicWriteAsync;
    let completedDuringStop = false;
    let childExit: Promise<number | null> | undefined;
    const spy = vi
      .spyOn(teamAtomicWrite, 'atomicWriteAsync')
      .mockImplementation(async (target, data, options) => {
        if (
          String(target).endsWith('launch-freshness.json') &&
          String(data).includes('"kind":"stop"')
        ) {
          const child = spawn(
            process.execPath,
            [
              path.resolve('node_modules/tsx/dist/cli.mjs'),
              '--tsconfig',
              config,
              path.resolve('test/main/services/team/fixtures/activityLaunchChild.ts'),
              alias,
              ready,
              done,
            ],
            { stdio: 'ignore' }
          );
          childExit = new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
          });
          const limit = Date.now() + 10000;
          while (!fs.existsSync(ready) && Date.now() < limit) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!fs.existsSync(ready)) throw new Error('New-run fixture did not start');
          await new Promise((resolve) => setTimeout(resolve, 800));
          completedDuringStop = fs.existsSync(done);
        }
        await write(target, data, options);
      });
    try {
      await store.markStopped('fixture', authority);
      expect(childExit).toBeDefined();
      expect(await childExit).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(completedDuringStop).toBe(false);
    const freshness = JSON.parse(
      fs.readFileSync(path.join(teamDir, 'launch-freshness.json'), 'utf8')
    );
    expect(freshness).toMatchObject({ kind: 'launch', runId: 'other-process-run' });
  }, 15000);

  it('releases the lock before the next microtask in the same event loop', async () => {
    const scope = path.join(teamDir, 'board-state');
    const controller = createController({
      teamName: 'fixture',
      claudeDir: fixture.dir,
      localTaskBoard: true,
    });
    let heldInMicrotask: boolean | undefined;
    let writeError: unknown;
    await withFileLockForSyncOperation(scope, () => {
      expect(fs.existsSync(`${scope}.lock`)).toBe(true);
      queueMicrotask(() => {
        heldInMicrotask = fs.existsSync(`${scope}.lock`);
        if (!heldInMicrotask) {
          try {
            controller.taskBoard.addReviewer('worker');
          } catch (error) {
            writeError = error;
          }
        }
      });
    });
    expect(heldInMicrotask).toBe(false);
    expect(writeError).toBeUndefined();
    expect(controller.kanban.listReviewers()).toContain('worker');
  });
});
