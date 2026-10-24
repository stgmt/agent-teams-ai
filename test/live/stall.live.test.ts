import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runtimePidOf } from './harness/leadBriefing';
import { createSandbox, startApp, type LiveSandbox, type RunningApp } from './harness/sandboxApp';
import {
  ControlApi,
  createDraftTeam,
  launchTeam,
  openController,
  readBoard,
  readInbox,
  readRunState,
  readRuntimeJournal,
  stopTeam,
  waitUntil,
  type SandboxTeamSpec,
} from './harness/sandboxTeam';
import { observeLaunch, type TeamCtx } from './harness/teamRun';

// S4.1: a task assigned to a Claude member that does not start it is reported to the lead by
// the watcher, as a message from the app (`system`). The owner is gone (its runtime process is
// ended before the task exists), so nobody can pick the task up: the shape of a task that "was
// assigned and nobody picked up". A live owner picks up an unannounced task by itself, so a live
// owner cannot stand for this case. The thresholds of the watcher are set by the test through
// the settings of the app, so the signal comes in about two minutes instead of the default
// eight; the code path is the same.

const TEAM = 'sandbox-stall';
const MODEL = process.env.LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() || process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const LEAD_INBOX = 'team-lead';
const MEMBERS = ['alpha'];

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  members: MEMBERS.map((name) => ({ name, role: 'developer', model: MODEL })),
};

const WATCHER_SETTINGS = {
  CLAUDE_TEAM_PENDING_PICKUP_STALL_THRESHOLD_MS: '45000',
  CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS: '20000',
  CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS: '10000',
  CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS: '5000',
};

const LAUNCH_LIMIT_MS = 240_000;
const SIGNAL_LIMIT_MS = 360_000;

// The watcher writes the phrase into the summary of the message; the text lists the tasks.
const isStallSignal = (row: { from?: string; summary?: string }) =>
  row.from === 'system' && (row.summary ?? '').includes('Potential stalled tasks detected');

let sandbox: LiveSandbox;
let app: RunningApp;
let api: ControlApi;
let taskId = '';
let createdAt = 0;
let signalAt = 0;
const observations: { name: string; value: unknown }[] = [];
const savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

const ctx = (): TeamCtx => ({ sandbox, team: TEAM, members: MEMBERS, leadInbox: LEAD_INBOX });

describe('live: the watcher reports a task whose owner is gone and did not start it', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error('Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable');
    }
    sandbox = await createSandbox('stall');
    app = await startApp(sandbox, {
      appDir: APP_DIR,
      runtimePath: RUNTIME_PATH,
      env: WATCHER_SETTINGS,
    });
    api = new ControlApi(app.baseUrl);
    process.env.CLAUDE_TEAM_CONTROL_URL = app.baseUrl;

    await createDraftTeam(api, sandbox, SPEC);
    const launchStart = Date.now();
    const runId = await launchTeam(api, sandbox, TEAM);
    const launch = await observeLaunch(ctx(), launchStart, LAUNCH_LIMIT_MS);
    const states = launch.at(-1)?.states ?? {};
    for (const name of MEMBERS) {
      if (states[name] !== 'confirmed') {
        throw new Error(`Precondition failed: ${name} is "${states[name]}" after the launch`);
      }
    }
    await waitUntil('the run is ready', LAUNCH_LIMIT_MS, async () => (await readRunState(api, runId)) === 'ready');

    // The owner is gone (the process is ended, the team is not stopped), and it is not told
    // about the task.
    const pid = runtimePidOf(readRuntimeJournal(sandbox, TEAM, 'alpha'));
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    const task = openController(sandbox, TEAM).taskBoard.createTask({
      subject: 'Task nobody picks up',
      description: 'Automated test. Start the task, add a comment, complete it.',
      owner: 'alpha',
      createdBy: 'user',
      notifyOwner: false,
    }) as { id: string };
    taskId = task.id;
    createdAt = Date.now();
  }, 600_000);

  afterAll(async () => {
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    if (app && api) await stopTeam(api, TEAM).catch(() => undefined);
    await app?.stop();
    if (sandbox) {
      fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
      fs.writeFileSync(
        path.join(sandbox.root, 'samples.json'),
        JSON.stringify({ appDir: APP_DIR, taskId, createdAt, signalAt, observations }, null, 2)
      );
    }
  }, 120_000);

  it('S4.1: one signal about the task reaches the lead from the app, with no sender error', async () => {
    const signal = await waitUntil(
      'the stall signal for a task that was assigned and not started',
      SIGNAL_LIMIT_MS,
      () => {
        const task = readBoard(sandbox, TEAM).find((entry) => entry.id === taskId);
        if (task && task.status !== 'pending' && observations.length === 0) {
          observations.push({ name: 'the owner took the task before the signal', value: task.status });
        }
        return readInbox(sandbox, TEAM, LEAD_INBOX).find(
          (row) => isStallSignal(row) && (row.text ?? '').includes(taskId.slice(0, 8))
        );
      },
      5000
    );
    signalAt = Date.now();
    observations.push({ name: 'seconds from the task to the signal', value: Math.round((signalAt - createdAt) / 1000) });
    expect(signal).toBeTruthy();

    const signals = readInbox(sandbox, TEAM, LEAD_INBOX).filter(isStallSignal);
    expect(signals, 'signals in the lead inbox').toHaveLength(1);
    expect(fs.readFileSync(app.logFile, 'utf8')).not.toContain('Unknown from: system');
  });
});
