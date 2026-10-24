import * as agentTeamsControllerModule from 'agent-teams-controller';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildNativeAppManagedBootstrapSpecs } from '../../../../src/main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const { createController } = agentTeamsControllerModule;

// Real builder, real controller, real board files in a temp Claude root.
// S1.14: the startup context of a member carries no Actionable work. Work in the
// startup context keeps the runtime in the member's first turn, so the launch
// confirmation never arrives inside the window (bug A of the member startup spec).

describe('native app-managed bootstrap context carries no work (S1.14)', () => {
  let claudeRoot = '';

  beforeEach(async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), 'native-bootstrap-nowork-'));
    setClaudeBasePathOverride(claudeRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(claudeRoot, { recursive: true, force: true });
  });

  async function seedTeam(teamName: string, workerNames: string[]) {
    await mkdir(join(claudeRoot, 'teams', teamName), { recursive: true });
    await writeFile(
      join(claudeRoot, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'lead', role: 'team-lead' },
          ...workerNames.map((name) => ({ name, role: 'developer' })),
        ],
      })
    );
    const board = createController({ teamName, claudeDir: claudeRoot }).taskBoard;
    const running = board.createTask({
      subject: 'RUNNING_SENTINEL quarterly numbers',
      owner: 'bob',
    });
    board.startTask(String((running as { id: string }).id), 'bob');
    board.createTask({ subject: 'PENDING_SENTINEL ledger check', owner: 'bob' });
    return board;
  }

  const members = (names: string[]) =>
    names.map((name) => ({ name, providerId: 'anthropic' as const, role: 'developer' }));

  it('full context: no Actionable block, no task subjects, hand-over notice present', async () => {
    const board = await seedTeam('nowork-full', ['bob']);
    // The fixture is valid only if the ordinary queue does list the work.
    const ordinaryQueue = await board.taskBriefing('bob');
    expect(ordinaryQueue).toContain('Actionable:');
    expect(ordinaryQueue).toContain('RUNNING_SENTINEL');

    const specs = await buildNativeAppManagedBootstrapSpecs({
      teamName: 'nowork-full',
      cwd: '/tmp/workspace',
      members: members(['bob']),
    });
    const context = specs.get('bob')?.contextText ?? '';

    expect(context).toContain('Member briefing for bob on team "nowork-full"');
    expect(context).not.toContain('Actionable:');
    expect(context).not.toContain('RUNNING_SENTINEL');
    expect(context).not.toContain('PENDING_SENTINEL');
    expect(context).toContain('No Actionable work is loaded in this startup context');
    expect(context).toContain('New task assigned');
  });

  it('compact context (large roster): the same guarantee holds', async () => {
    const names = ['bob', ...Array.from({ length: 9 }, (_, index) => `peer-${index}`)];
    const board = await seedTeam('nowork-compact', names);
    expect(await board.taskBriefing('bob')).toContain('RUNNING_SENTINEL');

    const specs = await buildNativeAppManagedBootstrapSpecs({
      teamName: 'nowork-compact',
      cwd: '/tmp/workspace',
      members: members(names),
    });
    const context = specs.get('bob')?.contextText ?? '';

    expect(context).toContain('The app loaded compact startup context');
    expect(context).toContain('Current task briefing:');
    expect(context).not.toContain('Actionable:');
    expect(context).not.toContain('RUNNING_SENTINEL');
    expect(context).not.toContain('PENDING_SENTINEL');
    expect(context).toContain('No Actionable work is loaded in this startup context');
  });
});
