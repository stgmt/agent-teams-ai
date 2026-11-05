import { writeFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: vi.fn(() => ({ getMeta: vi.fn(async () => null) })),
}));
vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
  }),
}));
const tails = vi.hoisted(() => ({ release: vi.fn(async () => ({ diagnostics: [] as string[] })) }));
vi.mock('@main/services/team/lifecycle/teamForceStopFlow', async (original) => ({
  ...(await original<typeof import('@main/services/team/lifecycle/teamForceStopFlow')>()),
  releaseSharedRuntimeResourcesAfterStop: tails.release,
}));
// Only the external process reaper is substituted. Store, shared Stop flow,
// route/IPC registration and publication queues execute their real code.
vi.mock('@main/services/team/lifecycle/teamLeadProcessTreeReap', () => ({
  reapCursorAgentLeadTreesForStoppedTeam: vi.fn(async () => ({ killedPids: [], diagnostics: [] })),
}));
import { registerTeamRoutes } from '@main/http/teams';
import { readTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import Fastify from 'fastify';

import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../../src/main/ipc/teams';
import { TEAM_FORCE_STOP, TEAM_STOP } from '../../../../src/preload/constants/ipcChannels';

import type { HttpServices } from '@main/http';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const team = 'stop-publication-callers';
describe('Stop publication admission through real IPC/HTTP wrappers', () => {
  let temp: string;
  const store = new TeamLaunchStateStore();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipc = {
    handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(key, fn),
    removeHandler: (key: string) => handlers.delete(key),
  };
  const runtime = {
    stopTeam: vi.fn(async () => {}),
    getStopTargetRunId: vi.fn((): string | null => 'original'),
    getAliveTeams: () => [],
    isTeamAlive: () => true,
    getRuntimeState: async () => ({ state: 'stopped' }),
  };
  beforeEach(async () => {
    temp = await mkdtemp(path.join(os.tmpdir(), 'stop-publication-callers-'));
    setClaudeBasePathOverride(path.join(temp, 'claude'));
    await mkdir(path.join(getTeamsBasePath(), team), { recursive: true });
    await store.beginLaunch(team, 'original', ['alice'], () => true);
    initializeTeamHandlers(
      { getTeamData: vi.fn(async () => ({ members: [] })) } as never,
      { runtime } as never
    );
    registerTeamHandlers(ipc as never);
    tails.release.mockReset();
    tails.release.mockResolvedValue({ diagnostics: [] });
    runtime.stopTeam.mockClear();
    runtime.getStopTargetRunId.mockReset();
    runtime.getStopTargetRunId.mockReturnValue('original');
  });
  afterEach(async () => {
    removeTeamHandlers(ipc as never);
    handlers.clear();
    setClaudeBasePathOverride(null);
    const parent = await realpath(os.tmpdir());
    const target = await realpath(temp);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('stop-publication-callers-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a test fixture outside its scratch parent');
    }
    await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  async function invoke(surface: string, force: boolean, incomplete = false) {
    if (surface === 'ipc') {
      const result = await handlers.get(force ? TEAM_FORCE_STOP : TEAM_STOP)!({}, team);
      if (force) {
        expect(result).toMatchObject({
          success: true,
          data: { cleanupOutcome: incomplete ? 'incomplete' : 'completed' },
        });
      } else if (incomplete) {
        expect(result).toMatchObject({
          success: false,
          error: expect.stringContaining('team_stop_unconfirmed:stopped'),
        });
        vi.mocked(console.error).mockClear();
      } else {
        expect(result).toMatchObject({ success: true });
      }
      return;
    }
    const app = Fastify();
    registerTeamRoutes(app, { teamApis: { runtime } } as unknown as HttpServices);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/teams/${team}/${force ? 'force-stop' : 'stop'}`,
      });
      expect(response.statusCode).toBe(!force && incomplete ? 409 : 200);
      if (force)
        expect(response.json()).toMatchObject({
          cleanupOutcome: incomplete ? 'incomplete' : 'completed',
        });
      else if (incomplete) expect(response.json().error).toContain('team_stop_unconfirmed:stopped');
    } finally {
      await app.close();
    }
  }
  it.each([
    ['ipc', false],
    ['ipc', true],
    ['http', false],
    ['http', true],
  ] as const)('%s force=%s: stops and unpublishes its own captured run', async (surface, force) => {
    await invoke(surface, force);
    expect(runtime.stopTeam).toHaveBeenCalledExactlyOnceWith(team, 'original');
    expect(await readTeamLaunchFreshness(team)).toMatchObject({
      kind: 'stop',
      stoppedRunId: 'original',
    });
  });

  it.each([
    ['ipc', null],
    ['ipc', 'local-other'],
    ['http', null],
    ['http', 'local-other'],
  ] as const)('%s retains another process run when local target is %s', async (surface, target) => {
    runtime.getStopTargetRunId.mockReturnValue(target);
    await invoke(surface, false, true);
    expect(runtime.stopTeam).toHaveBeenCalledExactlyOnceWith(team, target);
    expect((await store.read(team))?.publicationRunId).toBe('original');
    expect(await readTeamLaunchFreshness(team)).toMatchObject({
      kind: 'launch',
      runId: 'original',
    });
    expect(await store.isStopped(team)).toBe(false);
    vi.mocked(console.warn).mockClear();
  });

  it.each([
    ['ipc', false],
    ['ipc', true],
    ['http', false],
    ['http', true],
  ] as const)(
    '%s force=%s: an older cleanup tail preserves a finished successor and its heartbeats',
    async (surface, force) => {
      const entered = deferred(),
        release = deferred();
      tails.release.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { diagnostics: [] };
      });
      const stopping = invoke(surface, force, true);
      await entered.promise;
      expect(runtime.stopTeam).toHaveBeenCalledOnce();
      const launching = store.beginLaunch(team, 'successor', ['alice'], () => true);
      release.resolve();
      expect(await launching).toBe(true);
      const successor = createPersistedLaunchSnapshot({
        teamName: team,
        expectedMembers: ['alice'],
        launchPhase: 'finished',
        members: {},
      });
      expect(await store.write(team, successor, { runId: 'successor' })).toBe(true);
      await stopping;
      const reopened = new TeamLaunchStateStore();
      expect(await reopened.read(team)).toMatchObject({
        publicationRunId: 'successor',
        launchPhase: 'finished',
      });
      expect(await reopened.isStopped(team)).toBe(false);
      expect(await readTeamLaunchFreshness(team)).toMatchObject({
        kind: 'launch',
        runId: 'successor',
      });
      expect(
        JSON.parse(
          await readFile(path.join(getTeamsBasePath(), team, 'launch-summary.json'), 'utf8')
        ).publicationRunId
      ).toBe('successor');
      expect(await reopened.write(team, { ...successor, publicationRunId: 'successor' })).toBe(
        true
      );
    }
  );

  it('a newly requested shared Stop revokes an older begin waiting in the publication queue', async () => {
    const entered = deferred(),
      release = deferred();
    const held = withTeamLaunchStatePublicationLock(team, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const launch = store.beginLaunch(team, 'pending-before-stop', ['alice'], () => true);
    const stopping = invoke('ipc', false);
    // IPC admission is synchronous, before it waits for the held queue.
    release.resolve();
    await held;
    expect(await launch).toBe(false);
    await stopping;
    expect(await store.isStopped(team)).toBe(true);
    expect(await readTeamLaunchFreshness(team)).toMatchObject({
      kind: 'stop',
      stoppedRunId: 'original',
    });
  });

  it.each([
    ['ipc', false],
    ['ipc', true],
    ['http', false],
    ['http', true],
  ] as const)(
    '%s force=%s: logs unreadable admission and attempts scoped Stop without unscoped cleanup',
    async (surface, force) => {
      const freshnessPath = path.join(getTeamsBasePath(), team, 'launch-freshness.json');
      await writeFile(freshnessPath, '{corrupt');
      await invoke(surface, force, true);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        surface === 'ipc' ? '[IPC:teams]' : '[HTTP:teams]',
        expect.stringContaining(`[${team}] Stopped-state admission failed:`)
      );
      vi.mocked(console.warn).mockClear();
      expect(runtime.stopTeam).toHaveBeenCalledOnce();
      expect(await readFile(freshnessPath, 'utf8')).toBe('{corrupt');
      expect((await store.read(team))?.publicationRunId).toBe('original');
    }
  );

  it('an older Stop cannot acquire a newer Stop admission by finishing late', async () => {
    const old = await store.beginStop(team);
    const newer = await store.beginStop(team);
    await store.markStopped(team, newer);
    const freshness = await readTeamLaunchFreshness(team);
    await new TeamLaunchStateStore().markStopped(team, old);
    expect(await readTeamLaunchFreshness(team)).toEqual(freshness);
  });
});
