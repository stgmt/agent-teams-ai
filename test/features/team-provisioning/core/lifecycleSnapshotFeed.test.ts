import { describe, expect, it } from 'vitest';

import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

import type {
  TeamLifecycleFeed,
  TeamLifecycleSnapshot,
} from '../../../../src/features/team-provisioning/contracts';

async function readSnapshot(feed: TeamLifecycleFeed): Promise<Readonly<TeamLifecycleSnapshot>> {
  const result = await feed.next();
  if (result.done) throw new Error('TEST expected a lifecycle snapshot');
  return result.value;
}

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'test-team', runId: 'TEST-run' };
const members = [
  { memberName: 'team-lead', role: 'lead' as const },
  { memberName: 'builder', role: 'member' as const },
];
const process = { pid: 100, birthId: 'TEST-birth' };

function ready(registry: MemberLifecycleRegistry) {
  registry.configureTeam(run, members);
  const tokens = registry.beginTeamStart(run, () => 'TEST-operation');
  for (const [i, token] of tokens.entries()) {
    registry.observeSpawn(token, { ...process, pid: process.pid + i });
    registry.observeConnected(token);
  }
  return tokens.find((token) => token.memberName === 'builder')!;
}

describe('single authoritative versioned lifecycle feed', () => {
  it('subscribes before configuration and publishes a complete synchronous transition, not an independent status calculation', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const feed = registry.watch(run.teamName);
    const pending = feed.next();
    ready(registry);
    const event = await pending;
    if (event.done) throw new Error('TEST feed ended before configuration');
    expect(event.value).toEqual(registry.snapshot(run.teamName));
    expect(event.value.state).toBe('ready');
    await feed.return();
  });

  it('hydrates the current version without changing registry state and projects OS exit before resource release', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const token = ready(registry);
    const before = registry.snapshot(run.teamName);
    const feed = registry.watch(run.teamName);
    expect(await readSnapshot(feed)).toEqual(before);
    expect(registry.snapshot(run.teamName)).toEqual(before);
    const waiting = readSnapshot(feed);
    registry.observeExit(token, { ...process, pid: 101 }, { code: 1, signal: null });
    const lost = await waiting;
    expect(lost).toEqual(registry.snapshot(run.teamName));
    expect(lost.members.builder).toMatchObject({
      phase: 'exited',
      process: null,
      resources: 'releasing',
      everConnected: true,
    });
    expect(lost.state).toBe('degraded');
    const released = readSnapshot(feed);
    registry.observeMemberReleased(token);
    expect((await released).members.builder.resources).toBe('released');
    await feed.return();
  });

  it('coalesces unconsumed changes to the newest version instead of accumulating an unbounded history', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const token = ready(registry);
    const feed = registry.watch(run.teamName);
    for (let i = 0; i < 30; i++) {
      registry.observeConnectionLost(token);
      await Promise.resolve();
      registry.observeConnected(token);
      await Promise.resolve();
    }
    expect(await readSnapshot(feed)).toEqual(registry.snapshot(run.teamName));
    const pending = feed.next();
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
  });

  it('isolates team subscriptions and cannot publish rejected stale observations as a new version', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const token = ready(registry);
    const feed = registry.watch(run.teamName);
    await feed.next();
    const pending = feed.next();
    registry.configureTeam({ ...run, teamName: 'test-other' }, members);
    expect(
      registry.observeExit(
        { ...token, generation: 999 },
        { ...process, pid: 101 },
        { code: 1, signal: null }
      )
    ).toBe(false);
    await Promise.resolve();
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
  });

  it('gives independent consumers the same immutable snapshot version and keeps them independent on unsubscribe', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const token = ready(registry);
    const first = registry.watch(run.teamName);
    const second = registry.watch(run.teamName);
    const [a, b] = await Promise.all([readSnapshot(first), readSnapshot(second)]);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.members.builder)).toBe(true);
    await first.return();
    const waiting = readSnapshot(second);
    registry.observeConnectionLost(token);
    const update = await waiting;
    expect(update.members.builder.phase).toBe('unresponsive');
    expect(update.version).toBeGreaterThan(a.version);
    expect(await first.next()).toMatchObject({ done: true });
    await second.return();
  });

  it('keeps a feed across run replacement with a new identity and a monotonic version', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    registry.configureTeam(run, members);
    const feed = registry.watch(run.teamName);
    const previous = await readSnapshot(feed);
    registry.requestTeamStop(run);
    registry.observeReleased(run);
    registry.configureTeam({ ...run, runId: 'TEST-next' }, members);
    await Promise.resolve();
    const next = await readSnapshot(feed);
    expect(next.identity.runId).toBe('TEST-next');
    expect(next.version).toBeGreaterThan(previous.version);
    await feed.return();
  });

  it('rejects concurrent reads instead of losing a waiter, and can close before its queued publication', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const feed = registry.watch(run.teamName);
    const pending = feed.next();
    await expect(feed.next()).rejects.toThrow('pending read');
    registry.configureTeam(run, members);
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
    const replacement = registry.watch(run.teamName);
    expect(await readSnapshot(replacement)).toEqual(registry.snapshot(run.teamName));
    await replacement.return();
    expect(() => registry.watch(' ')).toThrow('Team name');
  });

  it('releases a pending subscription on iterator return and closes async iteration on break', async () => {
    const registry = new MemberLifecycleRegistry(owner);
    const feed = registry.watch(run.teamName);
    const waiting = feed.next();
    await feed.return();
    expect(await waiting).toMatchObject({ done: true });
    ready(registry);
    expect(await feed.next()).toMatchObject({ done: true });
    const other = registry.watch(run.teamName);
    for await (const snapshot of other) {
      expect(snapshot.state).toBe('ready');
      break;
    }
    expect(await other.next()).toMatchObject({ done: true });
  });
});
