// @vitest-environment node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { stopTeamWithEscalation } from '@main/services/team/lifecycle/teamForceStopFlow';
import { assertEscalatedStopConfirmed } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeStopOutcome';
import { readTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { expect, it, vi } from 'vitest';

it('preserves a successor across processes and physical root aliases while the old stop waits', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-launch-authority-'));
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(scratch);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('stop-launch-authority-') || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a test fixture outside its scratch parent');
  }
  const root = path.join(scratch, 'claude');
  setClaudeBasePathOverride(root);
  await fs.mkdir(path.join(root, 'teams', 'fixture'), { recursive: true });
  const aliasRoot = path.join(scratch, 'alias-claude');
  await fs.mkdir(aliasRoot);
  await fs.symlink(
    path.join(root, 'teams'),
    path.join(aliasRoot, 'teams'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const store = new TeamLaunchStateStore();
  const child = spawn(
    process.execPath,
    [
      path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--tsconfig',
      path.join(process.cwd(), 'tsconfig.json'),
      path.join(
        process.cwd(),
        'test',
        'main',
        'services',
        'team',
        'fixtures',
        'launchStopAuthorityChild.ts'
      ),
      aliasRoot,
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  let ready!: () => void;
  let rejectReady!: (error: Error) => void;
  const locked = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += String(chunk);
    if (stdout.includes('LAUNCH_HAS_LOCK')) ready();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.once('error', rejectReady);
  child.once('exit', (code) => {
    if (!stdout.includes('LAUNCH_HAS_LOCK'))
      rejectReady(new Error(`child exited ${code}: ${stderr}`));
  });
  try {
    // The child is started only after the old publication exists.
    // Its lock is held before Stop snapshots old authority.
    expect(await store.beginLaunch('fixture', 'old-run', ['lead'], () => true)).toBe(true);
    child.stdin.write('start\n');
    await locked;
    const stop = vi.fn(async (_team: string, _run?: string | null) => undefined);
    const stopping = stopTeamWithEscalation('fixture', {
      stopTeam: stop,
      getStopTargetRunId: () => 'old-run',
      observeOwnedRuntimeRunIds: async () => ['old-run'],
      observeOwnedRuntimeLaneIds: async () => [],
      killRetainedRuntimeProcesses: async () => ({ killedPids: [], diagnostics: [] }),
      clearPendingPromptDeliveries: async () => ({ cleared: 0, diagnostics: [] }),
      logWarning: () => undefined,
      markTeamStopped: (team, authority) => store.markStopped(team, authority),
    });
    // The alias in the child must hold the same physical publication lock.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stop).not.toHaveBeenCalled();
    child.stdin.end('release\n');
    expect(await exited, stderr).toBe(0);
    expect(stdout).toContain('LAUNCH_DONE {"published":true}');
    const result = await stopping;
    expect(stop).toHaveBeenCalledExactlyOnceWith('fixture', 'old-run');
    expect(result).toMatchObject({ stopOutcome: 'stopped', cleanupOutcome: 'incomplete' });
    expect(() => assertEscalatedStopConfirmed(result)).toThrow(/team_stop_unconfirmed/);
    expect(await readTeamLaunchFreshness('fixture')).toMatchObject({
      kind: 'launch',
      runId: 'successor-run',
    });
    expect((await store.read('fixture'))?.publicationRunId).toBe('successor-run');
    expect(await store.isStopped('fixture')).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    setClaudeBasePathOverride(null);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}, 30_000);
