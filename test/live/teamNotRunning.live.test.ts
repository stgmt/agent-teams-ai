import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectRenderer, type RendererBridge } from './harness/rendererBridge';
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
  readInbox,
  waitUntil,
  type SandboxTeamSpec,
} from './harness/sandboxTeam';

import type { TeamRuntimeState } from '@shared/types';

// L3 of the "team is not running" modal: the real app, the real runtime, a real Haiku lead in a
// sandbox team. The owner's path is driven through the real renderer: dashboard -> team card ->
// "Launch" -> launch form -> the lead process is ended from outside (the case of `my-team`)
// -> the modal -> "Launch" -> the launch form. The owner writes to the dead lead in the chat of
// the team page: the modal comes back for every message. A team started through the HTTP control
// API (what agents and external callers use) must show the modal when its lead dies, too.
// See specs/team-not-running-modal/scenarios.md (NM-S01, NM-S04, NM-S09, NM-S10, NM-S11, NM-S13,
// NM-S23, NM-S24).
//
// Never aimed at a working installation or at `my-team`: the app keeps all its state in
// the sandbox directory (see harness/sandboxApp.ts). The renderer is driven through the DOM
// (`element.click()` inside the page), the same elements a mouse click reaches.

const TEAM = 'sandbox-not-running';
const MODEL = process.env.LIVE_MODEL?.trim() ?? 'claude-haiku-5-5';
const APP_DIR = path.resolve(process.env.LIVE_APP_DIR?.trim() ?? process.cwd());
const RUNTIME_PATH = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH?.trim() ?? '';

const LAUNCH_LIMIT_MS = 240_000;
const FORM_READY_LIMIT_MS = 90_000;
const MODAL_WINDOW_MS = 15_000;
const QUIET_WINDOW_MS = 6_000;
const MODAL_TITLE = `"${TEAM}" is not running`;
const OWNER_MESSAGE = 'live test: are you there?';
const SAVED_LINE = 'Your message was saved and will arrive after the team starts.';
const LEAD_INBOX = 'team-lead';

const SPEC: SandboxTeamSpec = {
  teamName: TEAM,
  leadModel: MODEL,
  leadPrompt:
    'This is an automated test team. You are the lead. Do not create tasks, do not message ' +
    'teammates and do not call any tool unless the user writes to you. Answer the first prompt ' +
    'with the single word OK.',
  members: [{ name: 'alpha', role: 'developer', model: MODEL }],
};

interface DialogView {
  /** Visible text of the dialog (title, text, buttons). */
  text: string;
  /** The button that has the keyboard focus, when it is inside the dialog. */
  focusedButton: string | null;
}

interface Observation {
  name: string;
  value: unknown;
}

let sandbox: LiveSandbox;
let app: RunningApp;
let api: ControlApi;
let bridge: RendererBridge;
let runId = '';
let leadPid = 0;
const observations: Observation[] = [];
const savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
          messages.push((JSON.parse(line) as { message?: string }).message ?? '');
        } catch {
          // A line the app is still writing: it is read whole on the next poll.
        }
      }
    }
  };
  visit(sandbox.userDataDir, 0);
  return messages;
}

async function runtimeOf(): Promise<TeamRuntimeState> {
  return (await api.get(`/api/teams/${TEAM}/runtime`)) as TeamRuntimeState;
}

async function openDialogs(): Promise<DialogView[]> {
  return bridge.evaluate<DialogView[]>(`(() => {
    const active = document.activeElement;
    return [...document.querySelectorAll('[role="dialog"]')].map((dialog) => ({
      text: dialog.innerText,
      focusedButton:
        active && dialog.contains(active) && active.tagName === 'BUTTON'
          ? active.innerText.trim()
          : null,
    }));
  })()`);
}

async function notRunningDialog(): Promise<DialogView | undefined> {
  return (await openDialogs()).find((dialog) => dialog.text.includes(MODAL_TITLE));
}

/** Waits for the "not running" modal; a miss reports what was on the screen instead. */
async function waitForModal(label: string): Promise<DialogView> {
  try {
    return await waitUntil(label, MODAL_WINDOW_MS, notRunningDialog, 250);
  } catch (error) {
    const runtime = await runtimeOf().catch((cause: unknown) => String(cause));
    throw new Error(
      `${(error as Error).message}; lead pid ${leadPid} alive: ${isAlive(leadPid)}; ` +
        `runtime: ${JSON.stringify(runtime)}; page: ${JSON.stringify(await describePage())}`
    );
  }
}

async function launchFormDialog(): Promise<DialogView | undefined> {
  return (await openDialogs()).find((dialog) => /(Launch|Relaunch) Team/.test(dialog.text));
}

async function pageText(): Promise<string> {
  return bridge.evaluate<string>('document.body.innerText');
}

/** Clicks a button of the page itself (not of a dialog) with exactly this label. */
async function clickPageButton(label: string): Promise<boolean> {
  return bridge.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (node) => node.innerText.trim() === ${JSON.stringify(label)} && !node.closest('[role="dialog"]')
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/** Clicks the enabled button whose label matches `pattern` inside the dialog that holds `marker`. */
async function clickDialogButton(marker: RegExp, pattern: RegExp): Promise<boolean> {
  return bridge.evaluate<boolean>(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((node) =>
      new RegExp(${JSON.stringify(marker.source)}).test(node.innerText)
    );
    const button = dialog && [...dialog.querySelectorAll('button')].find(
      (node) => new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)}).test(node.innerText.trim()) && !node.disabled
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

/**
 * Opens the team tab the way the owner does: the "Select Team" button of the dashboard opens the
 * list of teams, a click on the team card opens the team.
 */
async function openTeamTab(): Promise<void> {
  await waitUntil('the "Select Team" button of the dashboard', 60_000, () =>
    bridge.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.innerText.trim() === 'Select Team'
      );
      if (!button) return false;
      button.click();
      return true;
    })()`)
  );
  await waitUntil('the team card is in the list', 60_000, () =>
    bridge.evaluate<boolean>(`(() => {
      const card = [...document.querySelectorAll('[role="button"]')].find((node) =>
        node.innerText.includes(${JSON.stringify(TEAM)})
      );
      if (!card) return false;
      card.click();
      return true;
    })()`)
  );
}

/**
 * Submits the open launch form with its own "Skip preflight and launch" button: the provider
 * pre-flight check is not under test and takes from 20 s to more than 90 s on this machine.
 */
async function submitLaunchForm(): Promise<void> {
  await waitUntil('the launch form', 30_000, launchFormDialog, 250);
  try {
    await waitUntil('the "Skip preflight and launch" button', FORM_READY_LIMIT_MS, () =>
      clickDialogButton(/(Launch|Relaunch) Team/, /^Skip preflight and launch$/i)
    );
  } catch (error) {
    const shown = (await openDialogs()).map((dialog) => dialog.text);
    throw new Error(`${(error as Error).message}; dialogs on screen: ${JSON.stringify(shown)}`);
  }
}

/** Waits for a new run of the team to reach `ready` and returns its run id and lead pid. */
async function waitForReadyRun(previousRunId: string): Promise<{ runId: string; pid: number }> {
  return waitUntil('a new run is ready', LAUNCH_LIMIT_MS, async () => {
    const state = await runtimeOf();
    const progress = state.progress;
    if (!state.isAlive || !state.runId || state.runId === previousRunId) return null;
    if (progress?.state !== 'ready' || !Number.isInteger(progress.pid)) return null;
    return { runId: state.runId, pid: Number(progress.pid) };
  });
}

/** What the page offers to the owner right now; goes into the message of a failed wait. */
async function describePage(): Promise<unknown> {
  return bridge.evaluate<unknown>(`({
    offlineBanner: document.body.innerText.includes('Team is offline'),
    dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.innerText.slice(0, 80)),
    text: document.body.innerText.slice(0, 600),
    inputs: [...document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]')].map(
      (node) => node.tagName + '#' + node.id + '|' + (node.getAttribute('placeholder') ?? '')
    ),
    labels: [...document.querySelectorAll('button, [role="button"], [role="tab"]')]
      .map((node) => node.tagName + ':' + (node.getAttribute('aria-label') ?? node.innerText).trim().slice(0, 50))
      .filter((label) => !label.endsWith(':')),
  })`);
}

/**
 * Opens the chat with the lead the way the owner does (the "lead" thread of the Messages panel),
 * types into its composer and presses Send.
 */
async function writeInChat(text: string): Promise<void> {
  const composerId = `compose-${TEAM}`;
  try {
    // The chat with the lead stays open after the first message: its composer is already there.
    await waitUntil('the "lead" thread of the Messages panel', 30_000, () =>
      bridge.evaluate<boolean>(`(() => {
        if (document.getElementById(${JSON.stringify(composerId)})) return true;
        const thread = [...document.querySelectorAll('button')].find((node) =>
          (node.getAttribute('aria-label') ?? '').startsWith('lead,')
        );
        if (!thread) return false;
        thread.click();
        return true;
      })()`)
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}; page: ${JSON.stringify(await describePage())}`);
  }
  try {
    await waitUntil('the chat composer of the team page', 30_000, () =>
      bridge.evaluate<boolean>(`document.getElementById(${JSON.stringify(composerId)}) !== null`)
    );
  } catch (error) {
    throw new Error(`${(error as Error).message}; page: ${JSON.stringify(await describePage())}`);
  }
  await bridge.evaluate(`(() => {
    const box = document.getElementById(${JSON.stringify(composerId)});
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    box.focus();
    setValue.call(box, ${JSON.stringify(text)});
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitUntil('the enabled Send button of the composer', MODAL_WINDOW_MS, () =>
    bridge.evaluate<boolean>(`(() => {
      const button = document.querySelector('button.message-composer-send-button');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`)
  );
}

function ownerMessagesInLeadInbox(text: string): number {
  return readInbox(sandbox, TEAM, LEAD_INBOX).filter((row) => row.text?.includes(text)).length;
}

async function expectNoNotRunningDialog(windowMs: number): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    expect(await notRunningDialog(), 'the "not running" dialog is on screen').toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe('live: the "team is not running" modal in a sandbox team', () => {
  beforeAll(async () => {
    if (!RUNTIME_PATH) {
      throw new Error(
        'Set CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH to the claude-multimodel executable'
      );
    }
    sandbox = await createSandbox('team-not-running');
    const debugPort = await freePort();
    app = await startApp(sandbox, { appDir: APP_DIR, runtimePath: RUNTIME_PATH, debugPort });
    api = new ControlApi(app.baseUrl);
    process.env.CLAUDE_TEAM_CONTROL_URL = app.baseUrl;
    bridge = await connectRenderer(debugPort);

    await createDraftTeam(api, sandbox, SPEC);
    await openTeamTab();
    await waitUntil('the "Launch" button of the draft team', 30_000, () =>
      clickPageButton('Launch')
    );
    await submitLaunchForm();
    ({ runId, pid: leadPid } = await waitForReadyRun(''));
    // The team runs: the owner sees no notice.
    await expectNoNotRunningDialog(3_000);
  }, 600_000);

  afterAll(async () => {
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    bridge?.close();
    await app?.stop();
    // The login copy never outlives the run.
    if (sandbox) fs.rmSync(path.join(sandbox.claudeRoot, '.credentials.json'), { force: true });
    if (sandbox) {
      fs.writeFileSync(
        path.join(sandbox.root, 'not-running.json'),
        JSON.stringify({ runId, leadPid, observations }, null, 2)
      );
    }
  }, 60_000);

  it('NM-S01/S09: a lead process that dies shows the modal with the real exit code', async () => {
    expect(isAlive(leadPid), 'the lead runs before the kill').toBe(true);
    const killedAt = Date.now();
    process.kill(leadPid, 'SIGKILL');

    const dialog = await waitForModal('the "not running" dialog');
    const shownAfterMs = Date.now() - killedAt;

    const codeInDialog = /exit code (\d+)/.exec(dialog.text)?.[1];
    expect(codeInDialog, `exit code in the dialog text: ${dialog.text}`).toBeDefined();
    const logged = appLogMessages().filter((message) =>
      message.includes(`[${TEAM}] Team process exited unexpectedly (code ${codeInDialog})`)
    );
    expect(logged, 'the warn line of the app log with the same exit code').toHaveLength(1);
    expect(dialog.focusedButton, 'the Launch button has the focus').toBe('Launch');
    observations.push({ name: 'kill', value: { leadPid, exitCode: codeInDialog, shownAfterMs } });
  }, 120_000);

  it('NM-S10: "Launch" closes the modal and opens the launch form; closing the form does not bring the modal back', async () => {
    expect(
      await clickDialogButton(new RegExp(MODAL_TITLE), /^Launch$/),
      'Launch in the modal'
    ).toBe(true);

    await waitUntil('the launch form', MODAL_WINDOW_MS, launchFormDialog, 250);
    expect(await notRunningDialog(), 'the modal is closed while the form is open').toBeUndefined();

    expect(await clickDialogButton(/(Launch|Relaunch) Team/, /^Close$/), 'Close in the form').toBe(
      true
    );
    await waitUntil(
      'the launch form is closed',
      MODAL_WINDOW_MS,
      async () => (await launchFormDialog()) === undefined
    );
    await expectNoNotRunningDialog(QUIET_WINDOW_MS);
    expect(await pageText(), 'the banner of the stopped team stays').toContain('Team is offline');
  }, 120_000);

  it('NM-S24: every message the owner writes to the dead lead in the chat shows the modal again', async () => {
    const first = `${OWNER_MESSAGE} first`;
    await writeInChat(first);

    const firstDialog = await waitForModal('the "not running" dialog after the first message');
    expect(firstDialog.text, 'the witnessed exit stays the reason').toMatch(/exit code \d+/);
    expect(firstDialog.text).toContain(SAVED_LINE);
    expect(ownerMessagesInLeadInbox(first), 'the first message waits in the lead inbox').toBe(1);

    expect(await clickDialogButton(new RegExp(MODAL_TITLE), /^Close$/), 'Close in the modal').toBe(
      true
    );
    await waitUntil(
      'the modal is closed',
      MODAL_WINDOW_MS,
      async () => (await notRunningDialog()) === undefined
    );
    await expectNoNotRunningDialog(QUIET_WINDOW_MS);

    const second = `${OWNER_MESSAGE} second`;
    await writeInChat(second);

    const secondDialog = await waitForModal('the "not running" dialog after the second message');
    expect(secondDialog.text).toContain(SAVED_LINE);
    expect(ownerMessagesInLeadInbox(second), 'the second message waits in the lead inbox').toBe(1);
    observations.push({ name: 'chat-messages', value: { modalsAfterMessages: 2 } });

    expect(await clickDialogButton(new RegExp(MODAL_TITLE), /^Close$/), 'Close in the modal').toBe(
      true
    );
  }, 180_000);

  it('NM-S11: a real launch from the banner ends the episode without a modal', async () => {
    expect(await clickPageButton('Launch'), 'Launch in the banner').toBe(true);
    await submitLaunchForm();

    const next = await waitForReadyRun(runId);
    observations.push({ name: 'relaunch', value: { from: runId, to: next.runId, pid: next.pid } });
    ({ runId, pid: leadPid } = next);
    await expectNoNotRunningDialog(3_000);
  }, 600_000);

  it('NM-S04: Stop in the app does not show the modal', async () => {
    expect(await clickPageButton('Stop'), 'Stop in the team header').toBe(true);

    await waitUntil('the team is stopped', 60_000, async () => !(await runtimeOf()).isAlive);
    await waitUntil('the banner of the stopped team', MODAL_WINDOW_MS, async () =>
      (await pageText()).includes('Team is offline')
    );
    await expectNoNotRunningDialog(QUIET_WINDOW_MS);
  }, 120_000);

  it('NM-S13: a message to the stopped team shows the modal once and promises delivery after the start', async () => {
    const opened = await bridge.evaluate<boolean>(`(() => {
      const button = document.querySelector('button[aria-label="Send message"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    expect(opened, 'the "Send message" button of a member card').toBe(true);

    await waitUntil('the message dialog', MODAL_WINDOW_MS, () =>
      bridge.evaluate<boolean>(`document.getElementById('smd-message') !== null`)
    );
    await bridge.evaluate(`(() => {
      const box = document.getElementById('smd-message');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      box.focus();
      setValue.call(box, ${JSON.stringify(OWNER_MESSAGE)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitUntil('the enabled "Send" button', MODAL_WINDOW_MS, () =>
      bridge.evaluate<boolean>(`(() => {
        const dialog = document.getElementById('smd-message').closest('[role="dialog"]');
        const button = [...dialog.querySelectorAll('button')].find(
          (node) => node.innerText.trim() === 'Send' && !node.disabled
        );
        if (!button) return false;
        button.click();
        return true;
      })()`)
    );

    const dialog = await waitForModal('the "not running" dialog');
    expect(dialog.text).toContain(SAVED_LINE);
    expect(dialog.text, 'a stop by the owner leaves no exit to report').not.toMatch(/exit code/);
  }, 120_000);

  it('NM-S23: a team started through the HTTP control API shows the modal when its lead dies', async () => {
    // The previous test left its modal open; a launch closes it too, closing it is the owner's way.
    expect(await clickDialogButton(new RegExp(MODAL_TITLE), /^Close$/), 'Close in the modal').toBe(
      true
    );

    const httpRunId = await launchTeam(api, sandbox, TEAM);
    const next = await waitForReadyRun(runId);
    expect(next.runId, 'the run the control API started').toBe(httpRunId);
    ({ runId, pid: leadPid } = next);
    await expectNoNotRunningDialog(3_000);

    const killedAt = Date.now();
    process.kill(leadPid, 'SIGKILL');
    const dialog = await waitForModal('the "not running" dialog of the HTTP-launched team');
    expect(dialog.text).toMatch(/exit code \d+/);
    observations.push({
      name: 'http-launch-kill',
      value: { runId: httpRunId, leadPid, shownAfterMs: Date.now() - killedAt },
    });
  }, 600_000);
});
