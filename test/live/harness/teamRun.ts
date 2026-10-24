import type { LiveSandbox } from './sandboxApp';
import { readBootstrapState, readInbox, readRuntimeJournal } from './sandboxTeam';

// Observation of one launch of a sandbox team, from the files the app and the runtime write.

export interface TeamCtx {
  sandbox: LiveSandbox;
  team: string;
  members: string[];
  /** Name of the lead inbox file. */
  leadInbox: string;
}

export interface Sample {
  atMs: number;
  states: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls bootstrap-state.json of the run that started after `startedAfter` until `isDone` holds
 * (by default: every member is confirmed or one of them failed) or the limit passed.
 */
export async function observeLaunch(
  ctx: TeamCtx,
  startedAfter: number,
  limitMs: number,
  isDone: (states: Record<string, string>) => boolean = (states) => {
    const values = Object.values(states);
    return values.every((value) => value === 'confirmed') || values.includes('failed');
  }
): Promise<Sample[]> {
  const startedAt = Date.now();
  const observed: Sample[] = [];
  while (Date.now() - startedAt < limitMs) {
    const state = readBootstrapState(ctx.sandbox, ctx.team);
    if (state && state.startedAt >= startedAfter) {
      const states: Record<string, string> = {};
      for (const name of ctx.members) {
        const member = state.members.find((entry) => entry.name === name);
        states[name] = member ? (member.status === 'bootstrap_confirmed' ? 'confirmed' : member.status) : 'absent';
      }
      observed.push({ atMs: Date.now() - startedAfter, states });
      if (isDone(states)) break;
    }
    await sleep(1000);
  }
  return observed;
}

export function spawnedAtMs(ctx: TeamCtx, member: string, since: number): number {
  const event = readRuntimeJournal(ctx.sandbox, ctx.team, member).find(
    (entry) => entry.type === 'process_spawned' && Date.parse(entry.timestamp ?? '') >= since
  );
  if (!event?.timestamp) throw new Error(`${member} has no process_spawned event after the launch`);
  return Date.parse(event.timestamp);
}

export function confirmedAtMs(ctx: TeamCtx, member: string, since: number): number | null {
  const event = readRuntimeJournal(ctx.sandbox, ctx.team, member).find(
    (entry) => entry.type === 'bootstrap_confirmed' && Date.parse(entry.timestamp ?? '') >= since
  );
  return event?.timestamp ? Date.parse(event.timestamp) : null;
}

/**
 * The earliest sign that the member finished its startup turn: its first heartbeat to the lead
 * (`idle_notification`, the signal the app itself reads) or the runtime's own
 * `bootstrap_confirmed`, whichever came first. The two are written within a second or two of each
 * other, in either order.
 */
export function confirmationEvidenceAtMs(ctx: TeamCtx, member: string, since: number): number | null {
  const spawned = spawnedAtMs(ctx, member, since);
  const heartbeat = readInbox(ctx.sandbox, ctx.team, ctx.leadInbox)
    .filter((row) => row.from === member && row.text?.includes('"type":"idle_notification"'))
    .map((row) => Date.parse(row.timestamp ?? ''))
    .find((at) => at >= spawned);
  const journal = confirmedAtMs(ctx, member, since);
  const times = [heartbeat, journal].filter((at): at is number => typeof at === 'number');
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * The app calls the launch complete as soon as it has classified every member; the runtime
 * writes its own `bootstrap_confirmed` to the member journal a moment later. This waits for
 * those lines, so the assertions read a settled journal. It does not decide anything: a member
 * that really did not confirm keeps a journal without the line and the tests report it.
 */
export async function waitForJournals(
  ctx: TeamCtx,
  samples: Sample[],
  since: number,
  limitMs: number
): Promise<void> {
  const last = samples.at(-1)?.states ?? {};
  const awaited = ctx.members.filter((name) => last[name] === 'confirmed');
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (awaited.every((name) => confirmedAtMs(ctx, name, since) !== null)) return;
    await sleep(500);
  }
}
