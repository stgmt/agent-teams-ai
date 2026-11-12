import { registryTaskFixtureService } from '../../../../helpers/teamRuntimeSnapshot';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodePath, setClaudeBasePathOverride } from '../../../../../src/main/utils/pathDecoder';
import { JsonTaskStallJournalStore } from '../../../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { TeamTaskStallJournal } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';
import { TeamTaskStallNotifier } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallNotifier';
import { TeamTaskStallPolicy } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallPolicy';
import { TeamTaskStallSnapshotSource } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallSnapshotSource';

import type { ActiveTeamRegistry } from '../../../../../src/main/services/team/stallMonitor/ActiveTeamRegistry';
import type { TaskStallAlert } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { TeamTask } from '../../../../../src/shared/types';

// Real monitor, policy, journal, notifier and inbox persistence over an explicit unit registry dataset.
// Runtime/model processing are not exercised here; this is not live acceptance evidence.

const SIGNAL_SUMMARY = 'Potential stalled tasks detected';
const TEAM = 'fixture';

describe('stall monitor with registry tasks and real team journal/inbox files (R9)', () => {
  let claudeRoot = '';
  let monitor: TeamTaskStallMonitor | null = null;
  const registryTasks: TeamTask[] = [];
  const service = () => {
    const instance = registryTaskFixtureService({
      readBoardSnapshot: async (_teamName, options) =>
        structuredClone(
          registryTasks.filter((task) => options?.includeDeleted || task.status !== 'deleted')
        ),
    });
    // The app wires profile ownership before any background writer runs; this
    // fixture team belongs to the running profile.
    instance.setTeamProfileOwnership(async () => true);
    return instance;
  };

  const teamDir = () => join(claudeRoot, 'teams', TEAM);
  // Fixture registry mutations; there is deliberately no controller/local-file task writer.
  const board = () => ({
    createTask(request: {
      subject: string;
      owner: string;
      blockedBy?: string[];
      needsClarification?: 'lead' | 'user';
    }) {
      const task: TeamTask = {
        ...request,
        id: `registry-fixture-${registryTasks.length + 1}`,
        displayId: String(registryTasks.length + 1),
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      registryTasks.push(task);
      return structuredClone(task);
    },
    startTask(id: string, actor: string) {
      const task = registryTasks.find((task) => task.id === id);
      if (!task) throw new Error(`Registry fixture task not found: ${id}`);
      task.status = 'in_progress';
      task.workIntervals = [{ startedAt: new Date().toISOString() }];
      task.historyEvents = [
        {
          id: `start-${id}`,
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          actor,
          timestamp: new Date().toISOString(),
        },
      ];
    },
  });
  const inbox = (member: string): { from?: string; summary?: string; text?: string }[] => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  };
  const signals = () => inbox('alice').filter((row) => row.summary === SIGNAL_SUMMARY);

  // РИСК: двойник реестра активных команд. Имитирует «команда запущена»; определение живых
  // процессов и отслеживание журналов команды он не покрывает.
  const registry = {
    start: () => undefined,
    stop: async () => undefined,
    noteTeamChange: () => undefined,
    listActiveTeams: async () => [TEAM],
    isTeamOfThisProfile: async () => true,
  } as unknown as ActiveTeamRegistry;

  const startMonitor = () => {
    monitor = new TeamTaskStallMonitor(
      registry,
      new TeamTaskStallSnapshotSource({
        taskReader: {
          getTasks: async () =>
            structuredClone(registryTasks.filter((task) => task.status !== 'deleted')),
          getDeletedTasks: async () =>
            structuredClone(registryTasks.filter((task) => task.status === 'deleted')),
        },
      }),
      new TeamTaskStallPolicy(),
      new TeamTaskStallJournal({ store: new JsonTaskStallJournalStore() }),
      new TeamTaskStallNotifier(service())
    );
    monitor.start();
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    claudeRoot = mkdtempSync(join(tmpdir(), 'stall-monitor-real-'));
    setClaudeBasePathOverride(claudeRoot);
    registryTasks.length = 0;
    mkdirSync(teamDir(), { recursive: true });
    // The snapshot source needs the project directory of the team, as a running team has.
    const workspace = join(claudeRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const projectDir = join(claudeRoot, 'projects', encodePath(workspace));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'lead-session-1.jsonl'), '');
    writeFileSync(
      join(teamDir(), 'config.json'),
      JSON.stringify({
        name: TEAM,
        projectPath: workspace,
        leadSessionId: 'lead-session-1',
        members: [
          // The runtime lead is identified by agentType, never by a reserved role alone.
          { name: 'alice', agentType: 'team-lead', role: 'team-lead', providerId: 'anthropic' },
          { name: 'bob', agentType: 'general-purpose', role: 'developer', providerId: 'anthropic' },
        ],
      })
    );
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '150');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_THRESHOLD_MS', '300');
  });

  afterEach(async () => {
    await monitor?.stop();
    monitor = null;
    vi.unstubAllEnvs();
    setClaudeBasePathOverride(null);
    rmSync(claudeRoot, { recursive: true, force: true });
  });

  it('S4.1: a task assigned to a Claude member and not started reaches the lead exactly once', async () => {
    const task = board().createTask({ subject: 'Prepare the quarterly numbers', owner: 'bob' });
    startMonitor();

    await vi.waitFor(() => expect(signals()).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await sleep(1_200);

    expect(signals()).toHaveLength(1);
    expect(signals()[0].from).toBe('system');
    expect(signals()[0].text).toContain(String((task as { displayId?: string }).displayId));
  });

  it('S4.2: a work stall alert passes the real notifier and TeamDataService into the lead inbox', async () => {
    // The work thresholds (4 to 10 minutes) are constants of the policy, not environment
    // variables, so the scan is not driven here; the live run (S4.1 in L3) covers the full chain.
    const task = board().createTask({ subject: 'Reconcile the ledger', owner: 'bob' });
    board().startTask(String((task as { id: string }).id), 'bob');
    const alert: TaskStallAlert = {
      teamName: TEAM,
      taskId: String((task as { id: string }).id),
      displayId: String((task as { displayId?: string }).displayId),
      subject: 'Reconcile the ledger',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      reason: 'Potential work stall.',
      epochKey: 'work:epoch',
      owner: 'bob',
      taskRef: {
        taskId: String((task as { id: string }).id),
        displayId: String((task as { displayId?: string }).displayId),
        teamName: TEAM,
      },
    } as TaskStallAlert;

    await new TeamTaskStallNotifier(service()).notifyLead(TEAM, [alert]);

    expect(signals()).toHaveLength(1);
    expect(signals()[0].from).toBe('system');
  });

  it('S4.3: a task the owner started before the threshold gives no signal', async () => {
    const task = board().createTask({ subject: 'Started in time', owner: 'bob' });
    board().startTask(String((task as { id: string }).id), 'bob');
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.4: a task blocked by an unfinished dependency gives no signal', async () => {
    const blocker = board().createTask({ subject: 'First step', owner: 'bob' });
    board().startTask(String((blocker as { id: string }).id), 'bob');
    board().createTask({
      subject: 'Second step',
      owner: 'bob',
      blockedBy: [String((blocker as { id: string }).id)],
    });
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.5: a task waiting for clarification gives no signal', async () => {
    board().createTask({ subject: 'Needs an answer', owner: 'bob', needsClarification: 'lead' });
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.6: inside the pause between signals there is no second signal for the task', async () => {
    board().createTask({ subject: 'Left alone', owner: 'bob' });
    startMonitor();

    await vi.waitFor(() => expect(signals()).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await sleep(2_000);

    expect(signals()).toHaveLength(1);
  });

  it('S4.7: after the escalation steps are spent the signals stop and the end is logged once', async () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERT_COOLDOWN_MS', '400');
    board().createTask({ subject: 'Abandoned', owner: 'bob' });
    const exhaustedWarnings = () =>
      vi
        .mocked(console.warn)
        .mock.calls.map((call) => call.map(String).join(' '))
        .filter((text) => text.includes('pickup_escalation_exhausted'));
    startMonitor();

    await vi.waitFor(() => expect(exhaustedWarnings()).toHaveLength(1), {
      timeout: 12_000,
      interval: 100,
    });
    const spent = signals().length;
    await sleep(2_000);

    // The second step repeats the text of the first to the same recipient, and the message
    // store drops a repeat inside 30 minutes, so the lead sees one or two signals.
    expect(spent).toBeGreaterThanOrEqual(1);
    expect(spent).toBeLessThanOrEqual(2);
    expect(signals()).toHaveLength(spent);
    expect(exhaustedWarnings()).toHaveLength(1);
    // The expected end-of-escalation warning is consumed here; any other warning still fails the test.
    vi.mocked(console.warn).mockClear();
  });

  it('S4.8: inside the startup window of the team there is no signal', async () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '600000');
    board().createTask({ subject: 'Too early', owner: 'bob' });
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.9: a pending task owned by the lead gives no signal', async () => {
    board().createTask({ subject: 'The lead own task', owner: 'alice' });
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.10: an owner busy on another task in progress gives no signal for the pending one', async () => {
    const running = board().createTask({ subject: 'Running', owner: 'bob' });
    board().startTask(String((running as { id: string }).id), 'bob');
    board().createTask({ subject: 'Waiting its turn', owner: 'bob' });
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });
});
