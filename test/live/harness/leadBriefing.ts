import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LiveSandbox } from './sandboxApp';
import { readBoard, readInbox, type ControlApi } from './sandboxTeam';

// The "Members" section of `lead_briefing`, read back from its text, and the same values
// computed a second way, straight from the sources the section says it uses: the diagnostics
// route of the app, the inbox files and the task files. Nothing here calls the code under test.

export interface MemberLine {
  /** Everything after `- name: `, split at `; `. */
  parts: string[];
  line: string;
  tasks: number | null;
}

export function parseMembersSection(briefing: string): {
  header: string[];
  members: Record<string, MemberLine>;
} {
  const lines = briefing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('Members ('));
  if (start < 0) throw new Error('lead_briefing has no Members section');
  const header: string[] = [];
  const members: Record<string, MemberLine> = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('App liveness:')) {
      header.push(line);
      continue;
    }
    const match = /^- ([^:]+): (.*)$/.exec(line);
    if (match) {
      const parts = match[2].split('; ');
      const tasks = parts.find((part) => part.startsWith('tasks='));
      members[match[1]] = {
        parts,
        line,
        tasks: tasks ? Number(tasks.slice('tasks='.length)) : null,
      };
      continue;
    }
    // Task lines of a member start with two spaces; anything else ends the section.
    if (!line.startsWith('  ')) break;
  }
  return { header, members };
}

export interface MemberTruth {
  /** The diagnostics entry as the app returned it, for the failure message of a test. */
  entry: DiagnosticsMember | null;
  /** The process of the member is alive according to the runtime snapshot of the app. */
  processAlive: boolean | null;
  running: boolean | null;
  confirmed: boolean | null;
  unread: number;
  actionableTasks: number;
}

export interface DiagnosticsMember {
  memberName: string;
  launchState?: string;
  alive?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
}

/** Values of one member computed from the app, the inbox file and the task files. */
export async function readMemberTruth(
  api: ControlApi,
  sandbox: LiveSandbox,
  team: string,
  member: string
): Promise<MemberTruth> {
  const diagnostics = (await api.get(`/api/teams/${team}/members/diagnostics`)) as {
    members?: DiagnosticsMember[];
  };
  const entry = diagnostics.members?.find((item) => item.memberName.toLowerCase() === member);
  const unread = readInbox(sandbox, team, member).filter((row) => row.read === false).length;
  const actionableTasks = readBoard(sandbox, team).filter(
    (task) =>
      task.owner?.toLowerCase() === member &&
      (task.status === 'pending' || task.status === 'in_progress')
  ).length;
  return {
    entry: entry ?? null,
    processAlive: entry && typeof entry.alive === 'boolean' ? entry.alive : null,
    running: entry ? entry.alive === true || entry.runtimeAlive === true : null,
    confirmed: entry ? entry.bootstrapConfirmed === true : null,
    unread,
    actionableTasks,
  };
}

/** The `unread=N` value of a member line, or null when the line shows none. */
export function unreadOf(line: MemberLine): number | null {
  const part = line.parts.find((item) => item.startsWith('unread='));
  if (!part) return null;
  return Number(/^unread=(\d+)/.exec(part)?.[1]);
}

/** Process id the runtime journal recorded when it started the member. */
export function runtimePidOf(journal: { type: string; pid?: unknown }[]): number {
  const spawned = [...journal].reverse().find((event) => event.type === 'process_spawned');
  const pid = Number(spawned?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('journal has no process_spawned pid');
  return pid;
}

/**
 * Transcripts of the sandbox: `claude/projects/<project>/<session>.jsonl`. The one that holds
 * `needle` belongs to the session that was shown that text.
 */
export function findTranscriptWith(sandbox: LiveSandbox, needle: string): string | null {
  const projects = path.join(sandbox.claudeRoot, 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const dir of fs.readdirSync(projects)) {
    const folder = path.join(projects, dir);
    for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.jsonl'))) {
      const full = path.join(folder, file);
      if (fs.readFileSync(full, 'utf8').includes(needle)) return full;
    }
  }
  return null;
}

export interface AnswerTurn {
  /** Tool names in the order the session called them after the question. */
  tools: string[];
  /** Text blocks in the order they were written. */
  texts: string[];
  /** Index in `tools` before which the first text block was written (-1: no text yet). */
  toolsBeforeFirstText: number;
  finished: boolean;
}

/** What the session did after the line that holds `needle`, up to the end of its first answer. */
export function readAnswerTurn(transcript: string, needle: string): AnswerTurn {
  const rows = fs
    .readFileSync(transcript, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown; stop_reason?: string | null };
        };
      } catch {
        // A line the runtime is still writing: it is read whole on the next poll.
        return null;
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const asked = rows.findIndex((row) => JSON.stringify(row.message?.content ?? '').includes(needle));
  const turn: AnswerTurn = { tools: [], texts: [], toolsBeforeFirstText: -1, finished: false };
  if (asked < 0) return turn;
  for (const row of rows.slice(asked + 1)) {
    if (row.message?.role !== 'assistant' || !Array.isArray(row.message.content)) continue;
    for (const block of row.message.content as { type: string; name?: string; text?: string }[]) {
      if (block.type === 'tool_use' && block.name) turn.tools.push(block.name);
      if (block.type === 'text' && block.text?.trim()) {
        if (turn.texts.length === 0) turn.toolsBeforeFirstText = turn.tools.length;
        turn.texts.push(block.text);
      }
    }
    if (row.message.stop_reason === 'end_turn') {
      turn.finished = true;
      break;
    }
  }
  return turn;
}
