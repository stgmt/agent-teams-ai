import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readMemberTruth } from './harness/leadBriefing';
import { connectRenderer, waitForSettingsBridge, type RendererBridge } from './harness/rendererBridge';
import {
  createSandbox,
  freePort,
  startApp,
  type LiveSandbox,
  type RunningApp,
} from './harness/sandboxApp';
import {
  ControlApi,
  createDraftTeam,
  launchTeam,
  openController,
  readBoard,
  readInbox,
  readRunState,
  readRuntimeJournal,
  waitUntil,
  type SandboxTeamSpec,
} from './harness/sandboxTeam';
import { confirmedAtMs, observeLaunch, type TeamCtx } from './harness/teamRun';

import type {
  EditableMemberSettings,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '@features/team-provisioning/contracts';

// L3 of the Save + Restart bugfix: the real app, the real runtime, real models (Haiku, a few
// short turns per member) in a sandbox team. The settings of a running member are saved through
// the same bridge the dialog calls (`window.electronAPI.teams.updateMemberSettings` in the
// renderer -> IPC -> use case -> process restart), three times in a row. See
// specs/bugfix-member-save-restart/scenarios.md (SR-07, SR-08, SR-12, SR-16, SR-19).
//
// Never aimed at a working installation or at `my-team`: the app keeps all its state in
// the sandbox directory (see harness/sandboxApp.ts).

const TEAM = 'sandbox-save-restart';
const MODEL = process.env.LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() || process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';
const NONCE = Date.now().toString(36);
const LEAD_INBOX = 'team-lead';
const ALPHA = 'alpha';
const NEIGHBOURS = ['beta', 'gamma'];
const MEMBERS = [ALPHA, ...NEIGHBOURS];
const RESTARTS = 3;

const NOTE_FILE = 'UNCOMMITTED-NOTE.txt';
const NOTE_TEXT = `Unsaved work of alpha ${NONCE}\n`;

const FIRST_LAUNCH_LIMIT_MS = 240_000;
const NEW_PROCESS_WINDOW_MS = 60_000;
const CONFIRM_WINDOW_MS = 180_000;
const WORK_WINDOW_MS = 240_000;

/** Thirty steps with a unique last line: the whole workflow must reach the new process. */
function workflowOf(version: number): string {
  const steps = Array.from(
    { length: 30 },
    (_, index) => `Step ${index + 1}: keep answers short and factual.`
  );
  return `${steps.join('\n')}\nWF-${NONCE}-v${version}-LAST`;
}

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  members: [
    { name: ALPHA, role: 'developer', model: MODEL, workflow: workflowOf(1), isolation: 'worktree' },
    ...NEIGHBOURS.map((name) => ({ name, role: 'developer', model: MODEL })),
  ],
};

interface RestartObservation {
  version: number;
  commandId: string;
  elapsedMs: number;
  oldPid: number;
  newPid: number;
  spawnedAfterMs: number;
  confirmedAfterMs: number;
  contextHashChanged: boolean;
  taskId: string;
  taskCompletedAfterMs: number;
}

let sandbox: LiveSandbox;
let app: RunningApp;
let api: ControlApi;
let bridge: RendererBridge;
let launchStartedAt = 0;
let worktreePath = '';
/** Context hash of the launch that runs now; the journal of a member is cut at every spawn. */
let currentContextHash: string | null = null;
const neighbourPids: Record<string, number> = {};
const observations: RestartObservation[] = [];
const savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

const ctx = (): TeamCtx => ({ sandbox, team: TEAM, members: MEMBERS, leadInbox: LEAD_INBOX });

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  return run.stdout;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function spawnEvents(member: string, since: number) {
  return readRuntimeJournal(sandbox, TEAM, member).filter(
    (event) => event.type === 'process_spawned' && Date.parse(event.timestamp ?? '') >= since
  );
}

function latestSpawn(member: string): { pid: number; timestamp: string } {
  const event = spawnEvents(member, 0).at(-1);
  const pid = Number(event?.pid);
  if (!event?.timestamp || !Number.isInteger(pid)) throw new Error(`${member} has no process_spawned event`);
  return { pid, timestamp: event.timestamp };
}

function lastContextHash(member: string): string | null {
  const event = readRuntimeJournal(sandbox, TEAM, member)
    .filter((entry) => entry.type === 'bootstrap_confirmed')
    .at(-1);
  return typeof event?.contextHash === 'string' ? event.contextHash : null;
}

function contextHashAfter(member: string, since: number): string | null {
  const event = readRuntimeJournal(sandbox, TEAM, member).find(
    (entry) => entry.type === 'bootstrap_confirmed' && Date.parse(entry.timestamp ?? '') >= since
  );
  return typeof event?.contextHash === 'string' ? event.contextHash : null;
}

/** Transcripts of the sandbox (`claude/projects/<project>/<session>.jsonl`) that hold `needle`. */
function transcriptsWith(needle: string): string[] {
  const projects = path.join(sandbox.claudeRoot, 'projects');
  if (!fs.existsSync(projects)) return [];
  const found: string[] = [];
  for (const dir of fs.readdirSync(projects)) {
    const folder = path.join(projects, dir);
    for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.jsonl'))) {
      const full = path.join(folder, file);
      if (fs.readFileSync(full, 'utf8').includes(needle)) found.push(full);
    }
  }
  return found;
}

/** Messages of the durable application log (`app-errors*.ndjson`) of the sandbox app. */
function appLogMessages(): string[] {
  const messages: string[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) visit(full, depth + 1);
      if (!entry.isFile() || !/^app-errors(\.\d+)?\.ndjson$/.test(entry.name)) continue;
      for (const line of fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
        try {
          messages.push(String((JSON.parse(line) as { message?: unknown }).message ?? ''));
        } catch {
          // A line the app is still writing: it is read whole on the next poll.
        }
      }
    }
  };
  visit(sandbox.userDataDir, 0);
  return messages;
}

async function updateMemberSettings(
  request: UpdateMemberSettingsRequest
): Promise<UpdateMemberSettingsResult> {
  return bridge.evaluate<UpdateMemberSettingsResult>(
    `window.electronAPI.teams.updateMemberSettings(${JSON.stringify(request)})`
  );
}

/**
 * The dialog holds the fingerprint of the member it rendered. Here the product itself is asked for
 * the current one: a request with a placeholder fingerprint is answered with `target_conflict`
 * (nothing is changed) that carries the real fingerprint, and the fingerprint holds the settings.
 */
async function currentTarget(
  commandId: string
): Promise<{ fingerprint: string; settings: EditableMemberSettings }> {
  const probe = await updateMemberSettings({
    commandId: `${commandId}-probe`,
    idempotencyKey: `${commandId}-probe`,
    teamName: TEAM,
    memberName: ALPHA,
    expectedFingerprint: 'probe',
    targetKind: 'member',
    settings: {
      role: 'developer',
      workflow: null,
      isolation: null,
      providerId: null,
      providerBackendId: null,
      model: null,
      effort: null,
      fastMode: null,
      mcpPolicy: null,
    },
  });
  if (probe.outcome !== 'target_conflict' || !probe.actualFingerprint) {
    throw new Error(`The probe was not answered with the current fingerprint: ${JSON.stringify(probe)}`);
  }
  const parsed = JSON.parse(probe.actualFingerprint) as { settings: EditableMemberSettings };
  return { fingerprint: probe.actualFingerprint, settings: parsed.settings };
}

describe('live: Save + Restart of a running member in a sandbox team', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error('Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable');
    }
    sandbox = await createSandbox('save-restart');
    // A member with `isolation: worktree` needs a git repository with a commit.
    git(sandbox.projectDir, ['init', '-b', 'main']);
    git(sandbox.projectDir, ['config', 'user.email', 'live-test@example.invalid']);
    git(sandbox.projectDir, ['config', 'user.name', 'Live Test']);
    git(sandbox.projectDir, ['add', 'README.md']);
    git(sandbox.projectDir, ['commit', '-m', 'Initial commit']);

    const debugPort = await freePort();
    app = await startApp(sandbox, { appDir: APP_DIR, runtimePath: RUNTIME_PATH, debugPort });
    api = new ControlApi(app.baseUrl);
    process.env.CLAUDE_TEAM_CONTROL_URL = app.baseUrl;
    bridge = await connectRenderer(debugPort);
    await waitForSettingsBridge(bridge);

    await createDraftTeam(api, sandbox, SPEC);
    launchStartedAt = Date.now();
    const runId = await launchTeam(api, sandbox, TEAM);
    const samples = await observeLaunch(ctx(), launchStartedAt, FIRST_LAUNCH_LIMIT_MS);
    const states = samples.at(-1)?.states ?? {};
    for (const name of MEMBERS) {
      if (states[name] !== 'confirmed') {
        throw new Error(`Precondition failed: ${name} is "${states[name]}" after the launch`);
      }
    }
    await waitUntil('the run is ready', FIRST_LAUNCH_LIMIT_MS, async () =>
      (await readRunState(api, runId)) === 'ready'
    );

    for (const name of NEIGHBOURS) neighbourPids[name] = latestSpawn(name).pid;
    currentContextHash = lastContextHash(ALPHA);
    const started = readRuntimeJournal(sandbox, TEAM, ALPHA).find((event) => event.type === 'cli_started');
    worktreePath = path.resolve(String(started?.cwd ?? ''));
    if (!worktreePath || worktreePath.toLowerCase() === path.resolve(sandbox.projectDir).toLowerCase()) {
      throw new Error(`Precondition failed: alpha does not work in a worktree (cwd ${started?.cwd})`);
    }
    fs.writeFileSync(path.join(worktreePath, NOTE_FILE), NOTE_TEXT);
  }, 900_000);

  afterAll(async () => {
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    bridge?.close();
    await app?.stop();
    // The login copy never outlives the run.
    if (sandbox) fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
    if (sandbox) {
      fs.writeFileSync(
        path.join(sandbox.root, 'restarts.json'),
        JSON.stringify({ launchStartedAt, worktreePath, observations }, null, 2)
      );
    }
  }, 60_000);

  for (let version = 2; version < 2 + RESTARTS; version += 1) {
    const attempt = version - 1;

    it(`SR-07/08/12/16/19: Save + Restart ${attempt} of ${RESTARTS} puts alpha back into the team with workflow v${version}`, async () => {
      const commandId = `save-restart-${NONCE}-${attempt}`;
      const before = latestSpawn(ALPHA);
      const hashBefore = currentContextHash;
      expect(hashBefore, 'context hash of the launch before the restart').not.toBeNull();
      expect(isAlive(before.pid), 'alpha runs before the restart').toBe(true);

      // Work that waits for alpha. The product's own task writer; the owner is not notified, so
      // the only message about the task is the one the restart itself produces.
      const controller = openController(sandbox, TEAM);
      const task = controller.taskBoard.createTask({
        subject: `Restart job ${attempt}`,
        description:
          `Automated test. Add a task comment with exactly the text RESTART-${attempt}-${NONCE}, ` +
          'then complete the task. Do nothing else.',
        owner: ALPHA,
        createdBy: 'user',
        notifyOwner: false,
      }) as { id: string };

      const { fingerprint, settings } = await currentTarget(commandId);
      const requestedAt = Date.now();
      const result = await updateMemberSettings({
        commandId,
        idempotencyKey: commandId,
        teamName: TEAM,
        memberName: ALPHA,
        expectedFingerprint: fingerprint,
        targetKind: 'member',
        settings: { ...settings, workflow: workflowOf(version) },
      });
      const elapsedMs = Date.now() - requestedAt;

      // SR-07: the result is a started restart, the old process is gone, a new one runs.
      expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
      const spawned = await waitUntil(`alpha has a new process (restart ${attempt})`, NEW_PROCESS_WINDOW_MS, () =>
        spawnEvents(ALPHA, requestedAt - 1000).at(-1)
      );
      const newPid = Number(spawned.pid);
      expect(newPid, 'new pid').not.toBe(before.pid);
      expect(isAlive(before.pid), `old process ${before.pid} is gone`).toBe(false);
      expect(isAlive(newPid), `new process ${newPid} runs`).toBe(true);

      // The launch is confirmed by the product: the event, the app's own status, the new context.
      const confirmedAt = await waitUntil(`alpha confirms its launch (restart ${attempt})`, CONFIRM_WINDOW_MS, () =>
        confirmedAtMs(ctx(), ALPHA, requestedAt - 1000)
      );
      const truth = await waitUntil('the app lists alpha as alive and confirmed', 60_000, async () => {
        const current = await readMemberTruth(api, sandbox, TEAM, ALPHA);
        return current.processAlive === true && current.confirmed === true ? current : null;
      });
      expect(truth.entry?.launchState, 'launch state of alpha').toBeDefined();
      const hashAfter = contextHashAfter(ALPHA, requestedAt - 1000);
      expect(hashAfter, 'context hash of the new launch').not.toBeNull();
      expect(hashAfter, 'the startup context changed with the workflow').not.toBe(hashBefore);
      currentContextHash = hashAfter;

      // SR-07: the new workflow reached the new process whole, the old one is not what it was shown.
      await waitUntil(`the last line of workflow v${version} is in a transcript`, 60_000, () =>
        transcriptsWith(`WF-${NONCE}-v${version}-LAST`).length > 0
      );

      // SR-22: every restart got its own bootstrap check row, although the text is the same as in
      // the restarts before (the controller drops a repeated message unless the app opts out).
      const checkRows = readInbox(sandbox, TEAM, ALPHA).filter(
        (row) =>
          row.messageId?.startsWith('direct-') &&
          row.text?.includes('bootstrap_check') &&
          Date.parse(row.timestamp ?? '') >= requestedAt - 1000
      );
      expect(checkRows, `bootstrap check rows of restart ${attempt}`).toHaveLength(1);

      // SR-07: the work that waited for alpha is handed over exactly once and alpha does it.
      // The app's hand-over row only: the work-sync messages about the same task are another thing.
      const handedOver = () =>
        readInbox(sandbox, TEAM, ALPHA).filter(
          (row) =>
            row.messageId?.startsWith('startup-work:') &&
            row.taskRefs?.some((ref) => ref.taskId === task.id)
        );
      await waitUntil('the work of alpha arrived', CONFIRM_WINDOW_MS, () => handedOver().length > 0);
      const completedAt = await waitUntil(`alpha completes restart job ${attempt}`, WORK_WINDOW_MS, () => {
        const current = readBoard(sandbox, TEAM).find((entry) => entry.id === task.id);
        const commented = current?.comments?.some(
          (comment) => comment.author === ALPHA && comment.text?.includes(`RESTART-${attempt}-${NONCE}`)
        );
        return current?.status === 'completed' && commented ? Date.now() : null;
      });
      const rows = handedOver();
      expect(rows, 'inbox rows about the task').toHaveLength(1);

      // SR-08: the same worktree, nothing recreated, nothing lost.
      const started = readRuntimeJournal(sandbox, TEAM, ALPHA)
        .filter((event) => event.type === 'cli_started' && Date.parse(event.timestamp ?? '') >= requestedAt - 1000)
        .at(-1);
      expect(path.resolve(String(started?.cwd)).toLowerCase(), 'cwd of the new process').toBe(
        worktreePath.toLowerCase()
      );
      expect(fs.readFileSync(path.join(worktreePath, NOTE_FILE), 'utf8')).toBe(NOTE_TEXT);
      const worktrees = git(sandbox.projectDir, ['worktree', 'list', '--porcelain'])
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => path.resolve(line.slice('worktree '.length)).toLowerCase());
      expect(worktrees.filter((entry) => entry === worktreePath.toLowerCase()), 'worktree entries of alpha').toHaveLength(1);

      // SR-12: the neighbours were not touched.
      for (const name of NEIGHBOURS) {
        expect(latestSpawn(name).pid, `${name} pid`).toBe(neighbourPids[name]);
        expect(isAlive(neighbourPids[name]), `${name} runs`).toBe(true);
        expect(spawnEvents(name, launchStartedAt), `${name} starts`).toHaveLength(1);
      }

      // SR-16/19: the log tells the story and holds none of the old failures.
      const accepted = `Member settings update accepted: team=${TEAM} member=${ALPHA} command=${commandId} `;
      const finished = `Member settings update finished: team=${TEAM} member=${ALPHA} command=${commandId} `;
      const messages = await waitUntil('the log holds the accepted and finished lines', 15_000, () => {
        const all = appLogMessages();
        return all.some((line) => line.startsWith(accepted)) &&
          all.some((line) => line.startsWith(finished) && line.includes('effect=member_restart_started'))
          ? all
          : null;
      });
      expect(messages.filter((line) => /still waiting for process exit|identity does not match/i.test(line))).toEqual([]);

      observations.push({
        version,
        commandId,
        elapsedMs,
        oldPid: before.pid,
        newPid,
        spawnedAfterMs: Date.parse(String(spawned.timestamp)) - requestedAt,
        confirmedAfterMs: confirmedAt - requestedAt,
        contextHashChanged: hashAfter !== hashBefore,
        taskId: task.id,
        taskCompletedAfterMs: completedAt - requestedAt,
      });
    });
  }
});
