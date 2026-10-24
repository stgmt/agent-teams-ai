import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findTranscriptWith,
  parseMembersSection,
  readAnswerTurn,
  readMemberTruth,
  runtimePidOf,
  unreadOf,
} from './harness/leadBriefing';
import { createSandbox, startApp, type LiveSandbox, type RunningApp } from './harness/sandboxApp';
import {
  confirmationEvidenceAtMs as confirmationEvidence,
  confirmedAtMs as confirmedAt,
  observeLaunch,
  spawnedAtMs as spawnedAt,
  waitForJournals,
  type Sample,
  type TeamCtx,
} from './harness/teamRun';
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

// L3 of the member-startup bugfix: the real app, the real runtime, real models (Haiku, a few
// short turns per member) in a sandbox team. The same file runs against the original 2.17.10
// build (LIVE_APP_DIR points to it: red) and against the fixed one (green). See
// specs/bugfix-member-startup-and-lead-status/scenarios.md (S1.1-S1.3, S8.1).
//
// Two launches, as in the field: the first one creates the team (the startup context of a
// member carries no queue then); the second one starts the existing team, and that is where
// the original build puts the work of a member into its startup context.

const TEAM = 'sandbox-bootstrap';
const MODEL = process.env.LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() || process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';

// One wait step is 30 s of wall clock; eight of them keep ALPHA busy for about four minutes,
// longer than the ~185 s window in which the original build waits for a launch confirmation.
const WAIT_STEP_COMMAND = 'node -e "setTimeout(()=>{},30000)"';

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  // Nine teammates, like the field team: from ten roster entries on, the app switches the
  // startup context of every member to the compact variant that carries the task queue
  // (NativeAppManagedBootstrapContextBuilder, NATIVE_BOOTSTRAP_COMPACT_ROSTER_MEMBER_COUNT).
  // With fewer members the queue is cut off by the size bound and the bug does not show.
  members: [
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'zeta',
    'eta',
    'theta',
    'iota',
  ].map((name) => ({ name, role: 'developer', model: MODEL })),
};

const MEMBERS = SPEC.members.map((member) => member.name);
const LEAD_INBOX = 'team-lead';
// A member needs ~10-30 s from its own process start to the confirmation (measured in the
// sandbox with Haiku). Windows count from the start of the member process, not of the launch:
// members start one after another.
const CONTROL_CONFIRM_WINDOW_MS = 60_000;
const CONFIRM_WINDOW_MS = 120_000;
const FIRST_ACTION_WINDOW_MS = 120_000;
const FIRST_LAUNCH_LIMIT_MS = 240_000;
// Above the ~185 s window of the original build, so a missing confirmation shows up as `failed`.
const SECOND_LAUNCH_LIMIT_MS = 260_000;

let sandbox: LiveSandbox;
let app: RunningApp;
let launchedAt = 0;
let samples: Sample[] = [];
let alphaTaskId = '';
let betaTaskId = '';
let briefingBeforeConfirmation = '';
let api: ControlApi;
const observations: { nonce: string; tools: string[]; texts: string[] }[] = [];
const savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

const ctx = (): TeamCtx => ({ sandbox, team: TEAM, members: MEMBERS, leadInbox: LEAD_INBOX });
const spawnedAtMs = (member: string, since: number) => spawnedAt(ctx(), member, since);
const confirmedAtMs = (member: string, since: number) => confirmedAt(ctx(), member, since);
const confirmationEvidenceAtMs = (member: string, since: number) =>
  confirmationEvidence(ctx(), member, since);

describe('live: member startup in a sandbox team', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error('Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable');
    }
    sandbox = await createSandbox('bootstrap');
    app = await startApp(sandbox, { appDir: APP_DIR, runtimePath: RUNTIME_PATH });
    api = new ControlApi(app.baseUrl);
    // The lead tools reach the app through this variable (or the state file the app keeps while a
    // team runs); the test process plays the part of the MCP server of the lead.
    process.env.CLAUDE_TEAM_CONTROL_URL = app.baseUrl;

    // Launch 1: the team is created and every member confirms (a precondition, not a result).
    await createDraftTeam(api, sandbox, SPEC);
    const firstStart = Date.now();
    const firstRunId = await launchTeam(api, sandbox, TEAM);
    const first = await observeLaunch(ctx(), firstStart, FIRST_LAUNCH_LIMIT_MS);
    const firstStates = first.at(-1)?.states ?? {};
    for (const name of MEMBERS) {
      if (firstStates[name] !== 'confirmed') {
        throw new Error(`Precondition failed: ${name} is "${firstStates[name]}" after the first launch`);
      }
    }
    // A run stopped while it is still finalizing stays "already launching" in the app and the
    // next launch is answered with the old run, so the first run is let finish first.
    await waitUntil('the first run is ready', FIRST_LAUNCH_LIMIT_MS, async () =>
      (await readRunState(api, firstRunId)) === 'ready'
    );

    // Work that exists before the second launch, written by the product's own task writer while
    // the first run is up; the owner is not notified, so the only message about it is the one
    // the launch itself produces.
    const controller = openController(sandbox, TEAM);
    const alphaTask = controller.taskBoard.createTask({
      subject: 'Long wait job',
      description:
        'Automated wait test. Step 1: add a task comment with exactly the text ALPHA-STARTED. ' +
        `Step 2: run this shell command eight times, one command per tool call, strictly one ` +
        `after another and never in parallel: ${WAIT_STEP_COMMAND} . Step 3: add a task comment ` +
        'ALPHA-DONE and complete the task. Do nothing else.',
      owner: 'alpha',
      createdBy: 'user',
      notifyOwner: false,
    }) as { id: string };
    controller.taskBoard.startTask(alphaTask.id, 'alpha');
    alphaTaskId = alphaTask.id;
    const betaTask = controller.taskBoard.createTask({
      subject: 'Short job',
      description:
        'Automated test. Start the task, add a task comment with exactly the text BETA-STARTED, ' +
        'then complete the task. Do nothing else.',
      owner: 'beta',
      createdBy: 'user',
      notifyOwner: false,
    }) as { id: string };
    betaTaskId = betaTask.id;
    // The app watches the task files of a running team and tells the lead when a member starts a
    // task. The note is waited for here, while the team is up, as it is in the field: a note
    // that reached the lead inbox only after the next launch began would look to the app like a
    // heartbeat of the new run.
    await waitUntil('the start note of the long task reached the lead inbox', 15_000, () =>
      readInbox(sandbox, TEAM, LEAD_INBOX).some(
        (row) => row.from === 'alpha' && row.summary === `Task #${alphaTask.id.slice(0, 8)} started`
      )
    );

    await stopTeam(api, TEAM);

    // Launch 2: the existing team starts again with work waiting for two of its members.
    launchedAt = Date.now();
    await launchTeam(api, sandbox, TEAM);
    // S1.20: BETA asks for its queue while the app has not confirmed its launch. The answer is
    // taken once the app lists BETA as unconfirmed, so it is the answer to the real state.
    await waitUntil('the app lists beta as not confirmed', 60_000, async () => {
      const { members } = (await api.get(`/api/teams/${TEAM}/members/diagnostics`)) as {
        members: { memberName: string; bootstrapConfirmed?: boolean }[];
      };
      return members.find((entry) => entry.memberName === 'beta')?.bootstrapConfirmed === false;
    }, 500);
    briefingBeforeConfirmation = await openController(sandbox, TEAM).taskBoard.requestTaskBriefing('beta');
    samples = await observeLaunch(ctx(), launchedAt, SECOND_LAUNCH_LIMIT_MS);
    await waitForJournals(ctx(), samples, launchedAt, 60_000);
  }, 900_000);

  afterAll(async () => {
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    await app?.stop();
    // The login copy never outlives the run.
    if (sandbox) fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
    if (sandbox) {
      fs.writeFileSync(
        path.join(sandbox.root, 'samples.json'),
        JSON.stringify({ launchedAt, samples, observations }, null, 2)
      );
    }
  }, 60_000);

  it('S1.1 (control): members without tasks confirm in the second launch', () => {
    for (const member of MEMBERS.filter((name) => name !== 'alpha' && name !== 'beta')) {
      const at = confirmedAtMs(member, launchedAt);
      expect(at, `${member} bootstrap_confirmed in its runtime journal`).not.toBeNull();
      expect(at! - spawnedAtMs(member, launchedAt), `${member} confirmation delay`).toBeLessThan(
        CONTROL_CONFIRM_WINDOW_MS
      );
    }
  });

  it('S1.2/S8.1: a member with a long task in progress confirms before the work ends and is never failed', () => {
    expect(samples.some((sample) => sample.states.alpha === 'failed'), 'alpha was failed').toBe(false);
    const at = confirmedAtMs('alpha', launchedAt);
    expect(at, 'alpha bootstrap_confirmed in its runtime journal').not.toBeNull();
    expect(at! - spawnedAtMs('alpha', launchedAt)).toBeLessThan(CONFIRM_WINDOW_MS);
  });

  it('S1.3: a member with a pending task confirms and then starts it', async () => {
    expect(samples.some((sample) => sample.states.beta === 'failed'), 'beta was failed').toBe(false);
    const at = confirmedAtMs('beta', launchedAt);
    expect(at, 'beta bootstrap_confirmed in its runtime journal').not.toBeNull();
    expect(at! - spawnedAtMs('beta', launchedAt)).toBeLessThan(CONFIRM_WINDOW_MS);

    const started = await waitUntil(
      'beta starts its task after the confirmation',
      FIRST_ACTION_WINDOW_MS,
      () =>
        readBoard(sandbox, TEAM)
          .find((task) => task.id === betaTaskId)
          ?.historyEvents?.find(
            (event) =>
              event.type === 'status_changed' &&
              event.actor === 'beta' &&
              event.to === 'in_progress' &&
              Date.parse(event.timestamp) >= launchedAt
          )
    );
    expect(Date.parse(started.timestamp) - at!).toBeLessThan(FIRST_ACTION_WINDOW_MS);
  });

  it('S1.2/S1.3: each member gets exactly one assignment message per task, after the confirmation', () => {
    for (const [member, taskId] of [
      ['alpha', alphaTaskId],
      ['beta', betaTaskId],
    ]) {
      const rows = readInbox(sandbox, TEAM, member).filter((row) =>
        row.taskRefs?.some((ref) => ref.taskId === taskId)
      );
      expect(rows, `${member} inbox rows about ${taskId}`).toHaveLength(1);
      expect(rows[0].messageId).toMatch(/^startup-work:/);
      const evidence = confirmationEvidenceAtMs(member, launchedAt);
      expect(evidence, `${member} confirmation evidence`).not.toBeNull();
      expect(Date.parse(rows[0].timestamp ?? '')).toBeGreaterThanOrEqual(evidence!);
    }
  });

  it('S1.20: asked before the confirmation a member is told its work arrives as messages; after it, it gets the briefing', async () => {
    expect(briefingBeforeConfirmation).toContain('No Actionable work is loaded');
    expect(briefingBeforeConfirmation).toContain('after the app confirms your launch');
    expect(briefingBeforeConfirmation).not.toContain('Short job');

    const after = await openController(sandbox, TEAM).taskBoard.requestTaskBriefing('alpha');
    expect(after).not.toContain('No Actionable work is loaded');
    expect(after).toContain('Long wait job');
  });

  it('S1.2: the owner of the long task touches it within two minutes after the confirmation', async () => {
    const at = confirmedAtMs('alpha', launchedAt);
    expect(at, 'alpha bootstrap_confirmed in its runtime journal').not.toBeNull();
    const comment = await waitUntil(
      'alpha comments on its long task',
      FIRST_ACTION_WINDOW_MS,
      () =>
        readBoard(sandbox, TEAM)
          .find((task) => task.id === alphaTaskId)
          ?.comments?.find(
            (entry) => entry.author === 'alpha' && Date.parse(entry.createdAt ?? '') >= launchedAt
          )
    );
    expect(Date.parse(comment.createdAt ?? '') - at!).toBeLessThan(FIRST_ACTION_WINDOW_MS);
  });

  // lead_briefing, section "Members": the real controller of the lead tools against the real app.
  const briefing = () => openController(sandbox, TEAM).taskBoard.leadBriefing();

  it('S3.1: a member that runs and is confirmed shows so', async () => {
    const { members } = parseMembersSection(await briefing());
    expect(members.gamma, 'gamma line').toBeDefined();
    expect(members.gamma.parts[0]).toMatch(/^running=yes, launch=\S+, confirmed=yes/);
  });

  it('S3.4: a member without tasks and messages shows tasks=0 and unread=0', async () => {
    const { members } = parseMembersSection(await briefing());
    expect(members.epsilon.tasks).toBe(0);
    expect(unreadOf(members.epsilon)).toBe(0);
  });

  it('S3.9: every value of the section equals the one computed from the app, inboxes and board', async () => {
    for (const member of ['alpha', 'beta', 'gamma']) {
      const before = await readMemberTruth(api, sandbox, TEAM, member);
      const { members } = parseMembersSection(await briefing());
      const after = await readMemberTruth(api, sandbox, TEAM, member);
      const line = members[member];
      expect(line, `${member} line`).toBeDefined();
      // Messages and tasks change while the members work: a value is right when it equals the
      // truth read just before or just after the briefing.
      expect([before.unread, after.unread], `${member} unread`).toContain(unreadOf(line));
      expect([before.actionableTasks, after.actionableTasks], `${member} tasks`).toContain(line.tasks);
      expect(line.parts[0].startsWith(`running=${before.running ? 'yes' : 'no'}`)).toBe(true);
      expect(line.parts[0]).toContain(`confirmed=${before.confirmed ? 'yes' : 'no'}`);
    }
  });

  it('S3.2: a member whose runtime is gone, with an old unread message, shows running=no and its age', async () => {
    // The runtime of DELTA is ended the way the field lost it (the process is gone, the team is
    // not stopped); then the app has to report DELTA as not running.
    const pid = runtimePidOf(readRuntimeJournal(sandbox, TEAM, 'delta'));
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    const afterKill = await waitUntil('the app reports the process of delta as gone', 120_000, async () => {
      const truth = await readMemberTruth(api, sandbox, TEAM, 'delta');
      return truth.processAlive === false ? truth : null;
    });
    observations.push({
      nonce: 'DELTA-DIAGNOSTICS-AFTER-KILL',
      tools: [],
      texts: [JSON.stringify(afterKill.entry)],
    });

    // РИСК: давность записана тестом, а не набрана временем. The message is written by the
    // product's own writer; only its time is moved 65 hours back.
    openController(sandbox, TEAM).messages.sendMessage({
      to: 'delta',
      from: 'team-lead',
      text: 'Please report your status.',
      summary: 'Status request',
    });
    const inboxFile = path.join(sandbox.claudeRoot, 'teams', TEAM, 'inboxes', 'delta.json');
    const rows = JSON.parse(fs.readFileSync(inboxFile, 'utf8')) as { timestamp?: string; read?: boolean }[];
    const unread = rows.filter((row) => row.read === false);
    expect(unread, 'the new message is the only unread one').toHaveLength(1);
    unread[0].timestamp = new Date(Date.now() - 65 * 3_600_000).toISOString();
    fs.writeFileSync(inboxFile, JSON.stringify(rows, null, 2));

    const { members } = parseMembersSection(await briefing());
    expect(members.delta.parts[0]).toMatch(/^running=no/);
    expect(members.delta.parts[1]).toMatch(/^unread=1, oldest unread 65h /);
  });

  it('S5.1: asked about a task, the lead calls lead_briefing before it writes anything, 3 times of 3', async () => {
    const controller = openController(sandbox, TEAM);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const nonce = `STATUS-QUESTION-${attempt}-${Date.now().toString(36)}`;
      controller.messages.sendMessage({
        to: 'team-lead',
        from: 'user',
        text: `${nonce}: what is going on with the task of alpha? Answer in one or two sentences.`,
        summary: 'Status question',
      });
      const transcript = await waitUntil('the question reached the lead session', 120_000, () =>
        findTranscriptWith(sandbox, nonce)
      );
      const turn = await waitUntil('the lead finished its answer', 180_000, () => {
        const current = readAnswerTurn(transcript, nonce);
        return current.finished ? current : null;
      });
      observations.push({ nonce, tools: turn.tools, texts: turn.texts });
      expect(turn.tools[0], `answer ${attempt}: first tool`).toMatch(/lead_briefing$/);
      expect(turn.toolsBeforeFirstText, `answer ${attempt}: tools before the first text`).toBeGreaterThanOrEqual(1);
      const beforeAnswer = turn.tools.slice(0, Math.max(turn.toolsBeforeFirstText, 1));
      expect(
        beforeAnswer.filter((name) => name.endsWith('message_send')),
        `answer ${attempt}: messages sent before the answer`
      ).toHaveLength(0);
    }
  });

  it('S3.5: with the team stopped the briefing is still answered and nobody is shown as running', async () => {
    await stopTeam(api, TEAM);
    const { members } = parseMembersSection(await briefing());
    for (const [name, line] of Object.entries(members)) {
      expect(line.parts[0], `${name} liveness`).toMatch(/^running=no/);
    }
  });
});
