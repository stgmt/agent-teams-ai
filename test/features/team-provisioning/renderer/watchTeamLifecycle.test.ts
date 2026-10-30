import { describe, expect, it, vi } from 'vitest';

import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';
import { watchTeamLifecycle } from '../../../../src/features/team-provisioning/renderer/watchTeamLifecycle';

import type {
  TeamLifecycleReadApi,
  TeamLifecycleReadResult,
} from '../../../../src/features/team-provisioning/contracts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const request = { expectedContext: owner, teamName: 'test-team' };

function setup() {
  const registry = new MemberLifecycleRegistry(owner);
  registry.configureTeam({ ...owner, teamName: 'test-team', runId: 'TEST-run' }, [
    { memberName: 'team-lead', role: 'lead' },
  ]);
  const snapshot = registry.snapshot('test-team');
  const source = registry.watch('test-team');
  const api: TeamLifecycleReadApi = {
    getLifecycleSnapshot: async () => snapshot,
    openLifecycleSubscription: vi.fn(async () => 'TEST-id'),
    readLifecycleSubscription: vi.fn(async () => source.next()),
    closeLifecycleSubscription: vi.fn(async () => {
      await source.return();
    }),
  };
  return { api, snapshot, registry };
}

describe('renderer lifecycle iteration', () => {
  it('passes the same authoritative value and closes exactly once on async-iteration break', async () => {
    const { api, snapshot } = setup();
    const feed = await watchTeamLifecycle(api, request);
    for await (const value of feed) {
      expect(value).toEqual(snapshot);
      break;
    }
    await feed.return();
    expect(api.openLifecycleSubscription).toHaveBeenCalledExactlyOnceWith(request);
    expect(api.closeLifecycleSubscription).toHaveBeenCalledExactlyOnceWith('TEST-id');
    expect(await feed.next()).toMatchObject({ done: true });
  });

  it('return interrupts a pending read and suppresses an in-flight value after disposal', async () => {
    const { api, snapshot } = setup();
    let finish!: (value: TeamLifecycleReadResult) => void;
    api.readLifecycleSubscription = vi.fn(
      () =>
        new Promise<TeamLifecycleReadResult>((resolve) => {
          finish = resolve;
        })
    );
    const feed = await watchTeamLifecycle(api, request);
    const pending = feed.next();
    await feed.return();
    finish({ done: false, value: snapshot });
    expect(await pending).toMatchObject({ done: true });
    expect(api.closeLifecycleSubscription).toHaveBeenCalledOnce();
  });

  it('rejects concurrent pulls locally without issuing another IPC request', async () => {
    const { api } = setup();
    const feed = await watchTeamLifecycle(api, request);
    await feed.next();
    const pending = feed.next();
    await expect(feed.next()).rejects.toThrow('pending read');
    expect(api.readLifecycleSubscription).toHaveBeenCalledTimes(2);
    await feed.return();
    expect(await pending).toMatchObject({ done: true });
  });

  it('propagates a terminal context failure without retrying or re-opening a subscription', async () => {
    const { api } = setup();
    api.readLifecycleSubscription = vi.fn(async () => {
      throw new Error('APP_CONTEXT_MISMATCH');
    });
    const feed = await watchTeamLifecycle(api, request);
    await expect(feed.next()).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(await feed.next()).toMatchObject({ done: true });
    await feed.return();
    expect(api.openLifecycleSubscription).toHaveBeenCalledOnce();
    expect(api.closeLifecycleSubscription).not.toHaveBeenCalled();
  });
});
