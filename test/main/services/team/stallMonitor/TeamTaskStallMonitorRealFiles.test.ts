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
import { TeamDataService } from '../../../../../src/main/services/team/TeamDataService';
import { createRegistryTaskTestBoundary, type RegistryTaskTestBoundary } from '../helpers/registryTaskTestBoundary';

import type { ActiveTeamRegistry } from '../../../../../src/main/services/team/stallMonitor/ActiveTeamRegistry';
import type { TaskStallAlert } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { TeamTask } from '../../../../../src/shared/types';

// Level L2 of the lead-status bugfix: the real monitor, snapshot source, policy, journal,
// notifier, TeamDataService and controller on real team files in a temp Claude root.
// Members are Claude (not OpenCode), as in my-team. Thresholds are the real
// environment variables of the monitor, set small so a scan cycle takes a fraction of a second.

const SIGNAL_SUMMARY = 'Potential stalled tasks detected';
const TEAM = 'fixture';

describe('stall monitor on real team files (R9)', () => {
  let claudeRoot = '';
  let monitor: TeamTaskStallMonitor | null = null;
  let registryBoundary: RegistryTaskTestBoundary | null = null;
  let nextTaskId = 1;

  const teamDir = () => join(claudeRoot, 'teams', TEAM);
  const inbox = (member: string): { from?: string; summary?: string; text?: string }[] => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  };
  const signals = () => inbox('alice').filter((row) => row.summary === SIGNAL_SUMMARY);
  const makeTask = (
    subject: string,
    owner: string,
    overrides: Partial<TeamTask> = {}
  ): TeamTask => {
    const id = String(nextTaskId++);
    return {
      id,
      subject,
      owner,
      status: 'pending',
      historyEvents: owner
        ? [{
            id: `owner-assigned-${id}`,
            type: 'owner_changed',
            timestamp: new Date(Date.now() - 30_000).toISOString(),
            to: owner,
          }]
        : [],
      ...overrides,
    };
  };
  const seedTasks = async (...tasks: TeamTask[]): Promise<TeamTask[]> => {
    if (!registryBoundary) throw new Error('The isolated registry fixture is not initialized.');
    await registryBoundary.replaceTasks(tasks);
    return tasks;
  };
  const makeStartedTask = (subject: string, owner: string): TeamTask =>
    makeTask(subject, owner, {
      status: 'in_progress',
      workIntervals: [{ startedAt: new Date().toISOString() }],
    });

  // РИСК: двойник реестра активных команд. Имитирует «команда запущена»; определение живых
  // процессов и отслеживание журналов команды он не покрывает.
  const registry = {
    start: () => undefined,
    stop: async () => undefined,
    noteTeamChange: () => undefined,
    listActiveTeams: async () => [TEAM],
  } as unknown as ActiveTeamRegistry;

  const startMonitor = () => {
    if (!registryBoundary) throw new Error('The isolated registry fixture is not initialized.');
    monitor = new TeamTaskStallMonitor(
      registry,
      new TeamTaskStallSnapshotSource({ taskReader: registryBoundary.taskReader }),
      new TeamTaskStallPolicy(),
      new TeamTaskStallJournal({ store: new JsonTaskStallJournalStore() }),
      new TeamTaskStallNotifier(new TeamDataService())
    );
    monitor.start();
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    vi.useRealTimers();
    claudeRoot = mkdtempSync(join(tmpdir(), 'stall-monitor-real-'));
    setClaudeBasePathOverride(claudeRoot);
    mkdirSync(teamDir(), { recursive: true });
    nextTaskId = 1;
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
        specProject: 'sandbox/project',
        specSlug: 'sandbox-spec',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead', providerId: 'anthropic' },
          { name: 'bob', role: 'developer', providerId: 'anthropic' },
        ],
      })
    );
    registryBoundary = await createRegistryTaskTestBoundary({ teamName: TEAM });
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', 'false');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_REMEDIATION_ENABLED', 'true');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '150');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');
    vi.stubEnv('CLAUDE_TEAM_PENDING_PICKUP_STALL_THRESHOLD_MS', '300');
  });

  afterEach(async () => {
    vi.useRealTimers();
    const monitorStopped = monitor?.stop();
    monitor = null;
    try {
      await registryBoundary?.dispose();
    } finally {
      registryBoundary = null;
      try {
        await monitorStopped;
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        setClaudeBasePathOverride(null);
        if (claudeRoot) {
          rmSync(claudeRoot, { recursive: true, force: true });
          claudeRoot = '';
        }
      }
    }
  });

  it('S4.1: a task assigned to a Claude member and not started reaches the lead exactly once', async () => {
    const [task] = await seedTasks(makeTask('Prepare the quarterly numbers', 'bob'));
    startMonitor();

    await vi.waitFor(() => expect(signals()).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await sleep(1_200);

    expect(signals()).toHaveLength(1);
    expect(signals()[0].from).toBe('system');
    expect(signals()[0].text).toContain(task.id);
  });

  it('S4.2: a work stall alert passes the real notifier, TeamDataService and controller into the lead inbox', async () => {
    // The work thresholds (4 to 10 minutes) are constants of the policy, not environment
    // variables, so the scan is not driven here; the live run (S4.1 in L3) covers the full chain.
    const [task] = await seedTasks(makeStartedTask('Reconcile the ledger', 'bob'));
    const alert: TaskStallAlert = {
      teamName: TEAM,
      taskId: task.id,
      displayId: task.id,
      subject: task.subject,
      branch: 'work',
      signal: 'turn_ended_after_touch',
      reason: 'Potential work stall.',
      epochKey: 'work:epoch',
      owner: 'bob',
      taskRef: {
        taskId: task.id,
        displayId: task.id,
        teamName: TEAM,
      },
    } as TaskStallAlert;

    await new TeamTaskStallNotifier(new TeamDataService()).notifyLead(TEAM, [alert]);

    expect(signals()).toHaveLength(1);
    expect(signals()[0].from).toBe('system');
  });

  it('S4.3: a task the owner started before the threshold gives no signal', async () => {
    await seedTasks(makeStartedTask('Started in time', 'bob'));
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.4: a task blocked by an unfinished dependency gives no signal', async () => {
    const blocker = makeStartedTask('First step', 'bob');
    const waiting = makeTask('Second step', 'bob', { blockedBy: [blocker.id] });
    await seedTasks(blocker, waiting);

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.5: a task waiting for clarification gives no signal', async () => {
    await seedTasks(makeTask('Needs an answer', 'bob', { needsClarification: 'lead' }));
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.6: inside the pause between signals there is no second signal for the task', async () => {
    await seedTasks(makeTask('Left alone', 'bob'));
    startMonitor();

    await vi.waitFor(() => expect(signals()).toHaveLength(1), { timeout: 15_000, interval: 100 });
    await sleep(2_000);

    expect(signals()).toHaveLength(1);
  });

  it('S4.7: after the escalation steps are spent the signals stop and the end is logged once', async () => {
    vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERT_COOLDOWN_MS', '400');
    await seedTasks(makeTask('Abandoned', 'bob'));
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
    await seedTasks(makeTask('Too early', 'bob'));
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.9: a pending task owned by the lead gives no signal', async () => {
    await seedTasks(makeTask('The lead own task', 'alice'));
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });

  it('S4.10: an owner busy on another task in progress gives no signal for the pending one', async () => {
    const running = makeStartedTask('Running', 'bob');
    const waiting = makeTask('Waiting its turn', 'bob');
    await seedTasks(running, waiting);
    startMonitor();

    await sleep(2_000);

    expect(signals()).toEqual([]);
  });
});
