import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseMembersSection } from './harness/leadBriefing';
import { createSandbox, startApp, type LiveSandbox, type RunningApp } from './harness/sandboxApp';
import {
  ControlApi,
  createDraftTeam,
  launchTeam,
  openController,
  readBoard,
  readBootstrapState,
  readInbox,
  readRunState,
  readRuntimeJournal,
  stopTeam,
  waitUntil,
  type SandboxTeamSpec,
} from './harness/sandboxTeam';
import {
  confirmationEvidenceAtMs as confirmationEvidence,
  confirmedAtMs as confirmedAt,
  observeLaunch,
  spawnedAtMs as spawnedAt,
  waitForJournals,
  type Sample,
  type TeamCtx,
} from './harness/teamRun';

// L3 of the member-startup bugfix, the cases in which a member does not start the normal way:
// a reviewer with a task in review (S1.4), a model that does not exist (S1.15), a member whose
// runtime process is ended before it confirms (S1.13) and the lead briefing of a member that
// never started (S3.2). The real app, the real runtime, real models; see startup.live.test.ts
// for the harness.

const TEAM = 'sandbox-failures';
const MODEL = process.env.LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const BAD_MODEL = 'claude-no-such-model-9';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() || process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const LEAD_INBOX = 'team-lead';

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  members: [
    { name: 'reviewer', role: 'reviewer', model: MODEL },
    { name: 'gamma', role: 'developer', model: MODEL },
    { name: 'epsilon', role: 'developer', model: MODEL },
  ],
};
const MEMBERS = SPEC.members.map((member) => member.name);

const CONFIRM_WINDOW_MS = 120_000;
const FIRST_ACTION_WINDOW_MS = 120_000;
const FIRST_LAUNCH_LIMIT_MS = 300_000;
// The original build waits ~185 s for a confirmation; the settled launch is awaited longer.
const SECOND_LAUNCH_LIMIT_MS = 330_000;

let sandbox: LiveSandbox;
let app: RunningApp;
let api: ControlApi;
let launchedAt = 0;
let samples: Sample[] = [];
let killedEpsilonAt = 0;
let reviewTaskId = '';
let epsilonTaskId = '';
const observations: { name: string; value: unknown }[] = [];
const savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

const ctx = (): TeamCtx => ({ sandbox, team: TEAM, members: MEMBERS, leadInbox: LEAD_INBOX });
const isTerminal = (states: Record<string, string>) =>
  Object.values(states).every((value) => value === 'confirmed' || value === 'failed');

function startupWorkRows(member: string, taskId: string) {
  return readInbox(sandbox, TEAM, member).filter(
    (row) =>
      (row.messageId ?? '').startsWith('startup-work:') &&
      row.taskRefs?.some((ref) => ref.taskId === taskId)
  );
}

function bootstrapMember(name: string) {
  return readBootstrapState(sandbox, TEAM)?.members.find((member) => member.name === name);
}

/**
 * Ends the runtime process of a member the moment its journal says the bootstrap text was
 * submitted: the process is then spawned for good and has not confirmed yet. A process that is
 * ended earlier is started again by the app itself (first run: pid 61416 ended, pid 19512
 * confirmed), which is not the case under test.
 */
async function endRuntimeWhenSubmitted(member: string, since: number): Promise<number> {
  const event = await waitUntil(
    `the bootstrap text of ${member} was submitted`,
    120_000,
    () => {
      const journal = readRuntimeJournal(sandbox, TEAM, member);
      const spawned = journal.find(
        (entry) => entry.type === 'process_spawned' && Date.parse(entry.timestamp ?? '') >= since
      );
      if (!spawned) return undefined;
      return journal.find(
        (entry) =>
          entry.type === 'bootstrap_submitted' &&
          entry.pid === spawned.pid &&
          !journal.some((other) => other.type === 'bootstrap_confirmed' && other.pid === spawned.pid)
      );
    },
    100
  );
  const pid = Number(event.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bootstrap_submitted has no pid');
  spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
  return Date.now();
}

describe('live: members that do not start the normal way', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error('Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable');
    }
    sandbox = await createSandbox('failures');
    app = await startApp(sandbox, { appDir: APP_DIR, runtimePath: RUNTIME_PATH });
    api = new ControlApi(app.baseUrl);
    process.env.CLAUDE_TEAM_CONTROL_URL = app.baseUrl;

    // Launch 1 creates the team; every member confirming is a precondition, not a result.
    await createDraftTeam(api, sandbox, SPEC);
    const firstStart = Date.now();
    const firstRunId = await launchTeam(api, sandbox, TEAM);
    const first = await observeLaunch(ctx(), firstStart, FIRST_LAUNCH_LIMIT_MS, isTerminal);
    const firstStates = first.at(-1)?.states ?? {};
    for (const name of MEMBERS) {
      if (firstStates[name] !== 'confirmed') {
        throw new Error(`Precondition failed: ${name} is "${firstStates[name]}" after the first launch`);
      }
    }
    observations.push({ name: 'launch 1 states', value: firstStates });
    await waitUntil('the first run is over', FIRST_LAUNCH_LIMIT_MS, async () =>
      ['ready', 'failed'].includes(await readRunState(api, firstRunId))
    );

    // GAMMA does a task and completes it while the team is up (as in the field); the note the
    // app writes to the lead about the start is waited for here.
    const controller = openController(sandbox, TEAM);
    const reviewTask = controller.taskBoard.createTask({
      subject: 'Task in review',
      description:
        'Automated test. This task is done. When you are asked to review it: call review_start ' +
        'and do nothing else. Do not approve it and do not request changes.',
      owner: 'gamma',
      createdBy: 'user',
      notifyOwner: false,
    }) as { id: string };
    reviewTaskId = reviewTask.id;
    controller.taskBoard.startTask(reviewTask.id, 'gamma');
    await waitUntil('the start note of the task reached the lead inbox', 15_000, () =>
      readInbox(sandbox, TEAM, LEAD_INBOX).some(
        (row) => row.from === 'gamma' && row.summary === `Task #${reviewTask.id.slice(0, 8)} started`
      )
    );
    controller.taskBoard.completeTask(reviewTask.id, 'gamma');
    await stopTeam(api, TEAM);

    // With the team down: the review is requested and the earlier session of REVIEWER has read
    // the request without acting on it; EPSILON has a pending task.
    controller.taskBoard.requestReview(reviewTask.id, { reviewer: 'reviewer', from: 'team-lead' });
    // РИСК: имитирует прошлую сессию, которая прочитала запрос и не успела действовать; метка
    // «прочитано» ставится правкой файла ящика, у контроллера для этого нет вызова.
    const reviewerInbox = path.join(sandbox.claudeRoot, 'teams', TEAM, 'inboxes', 'reviewer.json');
    const rows = JSON.parse(fs.readFileSync(reviewerInbox, 'utf8')) as { read?: boolean }[];
    for (const row of rows) row.read = true;
    fs.writeFileSync(reviewerInbox, JSON.stringify(rows, null, 2));

    const pending = (owner: string, subject: string) =>
      (
        controller.taskBoard.createTask({
          subject,
          description: 'Automated test. Start the task, add a comment, complete it.',
          owner,
          createdBy: 'user',
          notifyOwner: false,
        }) as { id: string }
      ).id;
    epsilonTaskId = pending('epsilon', 'Task of the member whose runtime is ended');

    // Launch 2: the existing team starts with work waiting for two members. The runtime of
    // EPSILON is ended as soon as it has started, so it can never confirm.
    launchedAt = Date.now();
    await launchTeam(api, sandbox, TEAM);
    const killing = endRuntimeWhenSubmitted('epsilon', launchedAt).then((at) => {
      killedEpsilonAt = at;
    });
    samples = await observeLaunch(ctx(), launchedAt, SECOND_LAUNCH_LIMIT_MS, isTerminal);
    await killing;
    // The journals of the members that confirmed are written a second or two after the app
    // says the launch is over.
    await waitForJournals(ctx(), samples, launchedAt, 60_000);
  }, 1_200_000);

  afterAll(async () => {
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    await app?.stop();
    if (sandbox) {
      // The login copy never outlives the run.
      fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
      fs.writeFileSync(
        path.join(sandbox.root, 'samples.json'),
        JSON.stringify({ launchedAt, killedEpsilonAt, samples, observations }, null, 2)
      );
    }
  }, 60_000);

  it('S1.4: the reviewer gets the review request once after its confirmation and takes the task', async () => {
    const at = confirmedAt(ctx(), 'reviewer', launchedAt);
    expect(at, 'reviewer bootstrap_confirmed in its runtime journal').not.toBeNull();
    expect(at! - spawnedAt(ctx(), 'reviewer', launchedAt)).toBeLessThan(CONFIRM_WINDOW_MS);

    // The review is still open after the first review_start, so it stays Actionable and the
    // app hands it over once, whether or not the model fetched its queue itself first.
    const rows = startupWorkRows('reviewer', reviewTaskId);
    expect(rows, 'startup-work rows about the review task').toHaveLength(1);
    expect(rows[0].messageId).toMatch(/:review$/);
    expect(Date.parse(rows[0].timestamp ?? '')).toBeGreaterThanOrEqual(
      confirmationEvidence(ctx(), 'reviewer', launchedAt)!
    );

    const touched = await waitUntil(
      'the reviewer takes the task in review',
      FIRST_ACTION_WINDOW_MS,
      () => {
        const task = readBoard(sandbox, TEAM).find((entry) => entry.id === reviewTaskId);
        return (
          task?.historyEvents?.find(
            (event) => event.actor === 'reviewer' && Date.parse(event.timestamp) >= launchedAt
          ) ??
          task?.comments?.find(
            (comment) => comment.author === 'reviewer' && Date.parse(comment.createdAt ?? '') >= launchedAt
          )
        );
      }
    );
    expect(touched).toBeTruthy();
  });

  it('S1.15: a model the runtime does not list is refused before any process starts, with the reason', async () => {
    // A second draft team, never launched successfully: the app checks the model of every member
    // against the runtime list at the launch request.
    const badTeam = 'sandbox-badmodel';
    await createDraftTeam(api, sandbox, {
      ...SPEC,
      teamName: badTeam,
      members: [{ name: 'delta', role: 'developer', model: BAD_MODEL }],
    });
    let answer = '';
    try {
      await api.post(`/api/teams/${badTeam}/launch`, { cwd: sandbox.projectDir });
    } catch (error) {
      answer = error instanceof Error ? error.message : String(error);
    }
    observations.push({ name: 'bad model launch answer', value: answer });
    expect(answer).toContain('answered 422');
    expect(answer).toContain(BAD_MODEL);
    expect(answer).toContain('does not list it as launchable');
    expect(
      fs.existsSync(path.join(sandbox.claudeRoot, 'teams', badTeam, 'runtime')),
      'a runtime folder of the refused team'
    ).toBe(false);
  });

  it('S1.13: a member whose runtime was ended before it confirmed fails honestly and gets no work', () => {
    expect(killedEpsilonAt, 'the runtime of epsilon was ended').toBeGreaterThan(0);
    const epsilon = bootstrapMember('epsilon');
    expect(epsilon?.status, 'epsilon status').toBe('failed');
    observations.push({ name: 'epsilon failure reason', value: epsilon?.failureReason });
    expect(epsilon?.failureReason ?? '', 'epsilon failure reason').not.toBe('');
    expect(confirmedAt(ctx(), 'epsilon', launchedAt), 'epsilon journal confirmation').toBeNull();
    expect(startupWorkRows('epsilon', epsilonTaskId), 'work delivered to epsilon').toHaveLength(0);
    expect(bootstrapMember('gamma')?.status, 'gamma is not touched').toBe('bootstrap_confirmed');
    expect(bootstrapMember('reviewer')?.status, 'reviewer is not touched').toBe('bootstrap_confirmed');
  });

  it('S3.2: a member that never confirmed, with an old unread message, is shown as not running with its age', async () => {
    // РИСК: давность записана тестом, а не набрана временем. The message is written by the
    // product's own writer; only its time is moved 65 hours back.
    openController(sandbox, TEAM).messages.sendMessage({
      to: 'epsilon',
      from: 'team-lead',
      text: 'Please report your status.',
      summary: 'Status request',
    });
    const inboxFile = path.join(sandbox.claudeRoot, 'teams', TEAM, 'inboxes', 'epsilon.json');
    const rows = JSON.parse(fs.readFileSync(inboxFile, 'utf8')) as { timestamp?: string; read?: boolean }[];
    const unread = rows.filter((row) => row.read === false);
    expect(unread.length, 'unread rows of epsilon').toBeGreaterThanOrEqual(1);
    unread.sort((a, b) => Date.parse(a.timestamp ?? '') - Date.parse(b.timestamp ?? ''));
    unread[0].timestamp = new Date(Date.now() - 65 * 3_600_000).toISOString();
    fs.writeFileSync(inboxFile, JSON.stringify(rows, null, 2));

    const briefing = await openController(sandbox, TEAM).taskBoard.leadBriefing();
    observations.push({
      name: 'briefing members section',
      value: briefing.split('\n').filter((line) => line.startsWith('- ')),
    });
    const { members } = parseMembersSection(briefing);
    expect(members.epsilon.parts[0]).toMatch(/^running=no/);
    expect(members.epsilon.parts[1]).toMatch(/oldest unread 65h /);
    expect(members.gamma.parts[0]).toMatch(/^running=yes/);
  });
});
