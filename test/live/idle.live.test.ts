import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSandbox, startApp, type LiveSandbox, type RunningApp } from './harness/sandboxApp';
import {
  ControlApi,
  createDraftTeam,
  launchTeam,
  openController,
  readBoard,
  readInbox,
  readRunState,
  stopTeam,
  waitUntil,
  type InboxRow,
  type SandboxTeamSpec,
} from './harness/sandboxTeam';
import { observeLaunch, type TeamCtx } from './harness/teamRun';

// S6.1-S6.3: the notices a lead gets when a member ends a turn (`idle_notification`, the comment
// note) must be the same on the original build and on the fixed one. The scenario is run on a
// team that is up, with ordinary assignments (the path the fix does not touch), and the notices
// are counted from the lead inbox. LIVE_APP_DIR picks the build; the counts of both builds go to
// samples.json and into evidence.md.

const TEAM = 'sandbox-idle';
const MODEL = process.env.LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() || process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const LEAD_INBOX = 'team-lead';
const MEMBERS = ['alpha', 'beta'];

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  members: MEMBERS.map((name) => ({ name, role: 'developer', model: MODEL })),
};

const LAUNCH_LIMIT_MS = 240_000;
const WORK_LIMIT_MS = 240_000;
// After the board shows both tasks completed, the members still end their last turn.
const SETTLE_MS = 30_000;

let sandbox: LiveSandbox;
let app: RunningApp;
let startedAt = 0;
let commentTaskId = '';
let silentTaskId = '';
const counts: Record<string, unknown> = {};

const ctx = (): TeamCtx => ({ sandbox, team: TEAM, members: MEMBERS, leadInbox: LEAD_INBOX });

function noticesFrom(member: string): InboxRow[] {
  return readInbox(sandbox, TEAM, LEAD_INBOX).filter(
    (row) => row.from === member && Date.parse(row.timestamp ?? '') >= startedAt
  );
}

const isIdle = (row: InboxRow) => (row.text ?? '').includes('"type":"idle_notification"');

describe('live: notices to the lead when a member ends a turn', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error('Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable');
    }
    sandbox = await createSandbox('idle');
    app = await startApp(sandbox, { appDir: APP_DIR, runtimePath: RUNTIME_PATH });
    const api = new ControlApi(app.baseUrl);

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
    // The first turns of the members end with their own notices; the counts below start after.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    // Two ordinary assignments on the team that is up: the product notifies each owner.
    startedAt = Date.now();
    const controller = openController(sandbox, TEAM);
    commentTaskId = (
      controller.taskBoard.createTask({
        subject: 'Task with a comment',
        description:
          'Automated test. Start the task, add a task comment with exactly the text IDLE-COMMENT, ' +
          'complete the task. Do nothing else.',
        owner: 'alpha',
        createdBy: 'user',
      }) as { id: string }
    ).id;
    silentTaskId = (
      controller.taskBoard.createTask({
        subject: 'Silent task',
        description:
          'Automated test. Start the task and complete it. Add no comment and send no message. ' +
          'Do nothing else.',
        owner: 'beta',
        createdBy: 'user',
      }) as { id: string }
    ).id;
    await waitUntil('both tasks are completed', WORK_LIMIT_MS, () => {
      const board = readBoard(sandbox, TEAM);
      return [commentTaskId, silentTaskId].every(
        (id) => board.find((task) => task.id === id)?.status === 'completed'
      );
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    for (const member of MEMBERS) {
      const rows = noticesFrom(member);
      counts[member] = {
        idle: rows.filter(isIdle).length,
        other: rows.filter((row) => !isIdle(row)).map((row) => row.summary ?? '(no summary)'),
      };
    }
    await stopTeam(api, TEAM);
  }, 1_200_000);

  afterAll(async () => {
    await app?.stop();
    if (sandbox) {
      fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
      fs.writeFileSync(
        path.join(sandbox.root, 'samples.json'),
        JSON.stringify({ appDir: APP_DIR, startedAt, counts }, null, 2)
      );
    }
  }, 60_000);

  it('S6.1: a member that ended its turn silently has an idle notice in the lead inbox', () => {
    expect((counts.beta as { idle: number }).idle).toBeGreaterThanOrEqual(1);
  });

  it('S6.2: a member that commented has the comment note and an idle notice in the lead inbox', () => {
    const alpha = counts.alpha as { idle: number; other: string[] };
    expect(alpha.other.some((summary) => summary.startsWith('Comment on #'))).toBe(true);
    expect(alpha.idle).toBeGreaterThanOrEqual(1);
  });

  it('S6.3: the counts of the run are recorded for the comparison between builds', () => {
    // The comparison itself is made on the two samples.json files (original and fixed build).
    expect(Object.keys(counts).sort()).toEqual(MEMBERS);
  });
});
