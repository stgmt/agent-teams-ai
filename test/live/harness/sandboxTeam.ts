import * as fs from 'node:fs';
import * as path from 'node:path';

import { createController } from 'agent-teams-controller';

import type { LiveSandbox } from './sandboxApp';

// Team side of the L3 harness: a draft team created and launched through the control API of
// the app (the same routes the MCP server and the UI use) and read back from the files the
// app and the runtime write. Nothing here replaces a part of the product.

export interface SandboxMemberSpec {
  name: string;
  role: string;
  model: string;
  workflow?: string;
  /** `worktree`: the member works in a git worktree of its own (the project must be a git repo). */
  isolation?: 'worktree';
}

export interface SandboxTeamSpec {
  teamName: string;
  leadModel: string;
  leadPrompt: string;
  members: SandboxMemberSpec[];
}

export interface BootstrapMemberRecord {
  name: string;
  status: string;
  failureReason?: string;
}

/** `bootstrap-state.json`: what the app knows about the confirmation of each member in a run. */
export interface BootstrapStateFile {
  runId: string;
  mode: string;
  phase: string;
  startedAt: number;
  members: BootstrapMemberRecord[];
}

export interface InboxRow {
  from?: string;
  to?: string;
  text?: string;
  summary?: string;
  timestamp?: string;
  read?: boolean;
  messageId?: string;
  taskRefs?: { taskId?: string }[];
}

export interface BoardTask {
  id: string;
  displayId?: string;
  subject: string;
  status: string;
  owner?: string;
  comments?: { author?: string; text?: string; createdAt?: string }[];
  historyEvents?: { type: string; actor?: string; to?: string; timestamp: string }[];
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} answered ${response.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

export class ControlApi {
  constructor(readonly baseUrl: string) {}

  get(route: string): Promise<unknown> {
    return requestJson(`${this.baseUrl}${route}`);
  }

  post(route: string, body: unknown): Promise<unknown> {
    return requestJson(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

export async function createDraftTeam(
  api: ControlApi,
  sandbox: LiveSandbox,
  spec: SandboxTeamSpec
): Promise<void> {
  await api.post('/api/teams', {
    teamName: spec.teamName,
    displayName: spec.teamName,
    cwd: sandbox.projectDir,
    providerId: 'anthropic',
    model: spec.leadModel,
    skipPermissions: true,
    prompt: spec.leadPrompt,
    members: spec.members.map((member) => ({
      name: member.name,
      role: member.role,
      model: member.model,
      ...(member.workflow ? { workflow: member.workflow } : {}),
      ...(member.isolation ? { isolation: member.isolation } : {}),
    })),
  });
}

/** Team files as the controller reads them: the same writer the product uses for tasks. */
export function openController(sandbox: LiveSandbox, teamName: string) {
  return createController({ teamName, claudeDir: sandbox.claudeRoot });
}

export async function launchTeam(
  api: ControlApi,
  sandbox: LiveSandbox,
  teamName: string
): Promise<string> {
  const response = (await api.post(`/api/teams/${teamName}/launch`, { cwd: sandbox.projectDir })) as {
    runId?: string;
    alreadyLaunching?: boolean;
  };
  if (!response.runId || response.alreadyLaunching) {
    throw new Error(`launch did not start a new run: ${JSON.stringify(response)}`);
  }
  return response.runId;
}

/** The in-app Stop control through the control API; returns once the app reports the team down. */
export async function stopTeam(api: ControlApi, teamName: string): Promise<void> {
  await api.post(`/api/teams/${teamName}/stop`, {});
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = (await api.get(`/api/teams/${teamName}/runtime`)) as { isAlive: boolean };
    if (!state.isAlive) return;
    if (Date.now() >= deadline) throw new Error(`${teamName} is still alive 60 s after stop`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function teamDir(sandbox: LiveSandbox, teamName: string): string {
  return path.join(sandbox.claudeRoot, 'teams', teamName);
}

function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A file caught half-written by the app: the next poll reads it whole.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function readBootstrapState(
  sandbox: LiveSandbox,
  teamName: string
): BootstrapStateFile | null {
  return readJsonIfExists<BootstrapStateFile>(path.join(teamDir(sandbox, teamName), 'bootstrap-state.json'));
}

export function readInbox(sandbox: LiveSandbox, teamName: string, member: string): InboxRow[] {
  return (
    readJsonIfExists<InboxRow[]>(path.join(teamDir(sandbox, teamName), 'inboxes', `${member}.json`)) ??
    []
  );
}

export function readBoard(sandbox: LiveSandbox, teamName: string): BoardTask[] {
  const dir = path.join(sandbox.claudeRoot, 'tasks', teamName);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJsonIfExists<BoardTask>(path.join(dir, file)))
    .filter((task): task is BoardTask => task !== null);
}

export interface RuntimeEvent {
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

/** Events the runtime of one member wrote to its journal (`runtime/<member>.runtime.jsonl`). */
export function readRuntimeJournal(
  sandbox: LiveSandbox,
  teamName: string,
  member: string
): RuntimeEvent[] {
  const file = path.join(teamDir(sandbox, teamName), 'runtime', `${member}.runtime.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as RuntimeEvent;
      } catch {
        // A line the runtime is still writing: it is read whole on the next poll.
        return null;
      }
    })
    .filter((event): event is RuntimeEvent => event !== null);
}

export async function waitUntil<T>(
  label: string,
  timeoutMs: number,
  probe: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  intervalMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Progress state of a provisioning run (`ready`, `failed`, `finalizing`, ...). */
export async function readRunState(api: ControlApi, runId: string): Promise<string> {
  return ((await api.get(`/api/teams/provisioning/${runId}`)) as { state: string }).state;
}
