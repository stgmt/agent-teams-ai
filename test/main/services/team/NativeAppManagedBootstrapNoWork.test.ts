import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registryOnlyTaskControlFixture } from './helpers/registryOnlyTaskControlFixture';
import {
  createRegistryTaskTestBoundary,
  type RegistryTaskTestBoundary,
} from './helpers/registryTaskTestBoundary';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import type { TeamTask } from '@shared/types';

const { createController } = registryOnlyTaskControlFixture;
const requireFromTest = createRequire(import.meta.url);
const desktopBinding = requireFromTest(
  '../../../../agent-teams-controller/src/internal/desktopControlBinding.js'
) as { isDesktopBound: () => boolean };

// The startup briefings read from a bound local task API, never the operator's registry.
describe('native app-managed bootstrap context carries no work (S1.14)', () => {
  const claudeRoot = registryOnlyTaskControlFixture.claudeDir;
  let registryBoundary: RegistryTaskTestBoundary;
  let restoreDesktopBinding: (() => void) | undefined;

  beforeEach(async () => {
    setClaudeBasePathOverride(claudeRoot);
    registryBoundary = await createRegistryTaskTestBoundary({ teamName: 'sandbox-spec' });
    await Promise.all(
      ['nowork-full', 'nowork-compact'].map((teamName) =>
        registryOnlyTaskControlFixture.clearTeam(teamName)
      )
    );
  });

  afterEach(async () => {
    restoreDesktopBinding?.();
    restoreDesktopBinding = undefined;
    setClaudeBasePathOverride(null);
    await Promise.all(
      ['nowork-full', 'nowork-compact'].map((teamName) =>
        registryOnlyTaskControlFixture.clearTeam(teamName)
      )
    );
    await registryBoundary.dispose();
  });

  afterAll(() => registryOnlyTaskControlFixture.dispose());


  async function seedTeam(teamName: string, workerNames: string[]) {
    await mkdir(join(claudeRoot, 'teams', teamName), { recursive: true });
    await writeFile(
      join(claudeRoot, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        specProject: 'sandbox/project',
        specSlug: 'sandbox-spec',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'lead', role: 'team-lead' },
          ...workerNames.map((name) => ({ name, role: 'developer' })),
        ],
      })
    );
    const board = createController({ teamName, claudeDir: claudeRoot }).taskBoard;
    const registryTasks: TeamTask[] = [];
    const createTask = (subject: string, status: TeamTask['status']) => {
      const task = board.createTask({ requirements: ['FR-1'], subject, owner: 'bob' });
      const createdTask = task as { id: string };
      const id = String(createdTask.id);
      registryOnlyTaskControlFixture.trackTask(teamName, id);
      registryTasks.push({
        id,
        displayId: id,
        subject,
        owner: 'bob',
        status,
        createdAt: '2026-10-22T10:00:00.000Z',
        updatedAt: '2026-10-22T10:00:00.000Z',
      });
      return task;
    };
    const running = createTask('RUNNING_SENTINEL quarterly numbers', 'in_progress');
    board.startTask(String((running as { id: string }).id), 'bob');
    createTask('PENDING_SENTINEL ledger check', 'pending');
    await registryBoundary.replaceTasks(registryTasks);
    return board;
  }

  const members = (names: string[]) =>
    names.map((name) => ({ name, providerId: 'anthropic' as const, role: 'developer' }));

  it('full context: no Actionable block, no task subjects; the controller carries the hand-over notice', async () => {
    const { buildNativeAppManagedBootstrapSpecs } = await import(
      '../../../../src/main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder'
    );
    const board = await seedTeam('nowork-full', ['bob']);
    // The local app-control fixture has no group-chat endpoint; avoid that unrelated read while
    // the task queue and hand-over assertions continue to use their real local fixtures.
    const wasDesktopBound = desktopBinding.isDesktopBound;
    desktopBinding.isDesktopBound = () => false;
    restoreDesktopBinding = () => {
      desktopBinding.isDesktopBound = wasDesktopBound;
    };
    // The fixture is valid only if the ordinary queue does list the work.
    const ordinaryQueue = await board.taskBriefing('bob');
    expect(ordinaryQueue).toContain('Actionable:');
    expect(ordinaryQueue).toContain('RUNNING_SENTINEL');

    const specs = await buildNativeAppManagedBootstrapSpecs(
      {
        teamName: 'nowork-full',
        cwd: '/tmp/workspace',
        members: members(['bob']),
      },
      registryBoundary.taskReader
    );
    const context = specs.get('bob')?.contextText ?? '';

    expect(context).toContain('Member briefing for bob on team "nowork-full"');
    expect(context).not.toContain('Actionable:');
    expect(context).not.toContain('RUNNING_SENTINEL');
    expect(context).not.toContain('PENDING_SENTINEL');

    // The full briefing of this build is longer than the builder's own bound
    // (MAX_NATIVE_BOOTSTRAP_BRIEFING_CHARS), which cuts the tail where the notice sits. The
    // notice is asserted on the controller output here and in the compact context below.
    const deferred = String(
      await board.memberBriefing('bob', {
        includeChatVisualizationProtocol: false,
        deferTaskQueue: true,
      })
    );
    expect(deferred).toContain('No Actionable work is loaded in this startup context');
    expect(deferred).toContain('New task assigned');

  });
  it('compact context (large roster): the same guarantee holds', async () => {
    const { buildNativeAppManagedBootstrapSpecs } = await import(
      '../../../../src/main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder'
    );
    const names = ['bob', ...Array.from({ length: 9 }, (_, index) => `peer-${index}`)];
    const board = await seedTeam('nowork-compact', names);
    expect(await board.taskBriefing('bob')).toContain('RUNNING_SENTINEL');

    const specs = await buildNativeAppManagedBootstrapSpecs(
      {
        teamName: 'nowork-compact',
        cwd: '/tmp/workspace',
        members: members(names),
      },
      registryBoundary.taskReader
    );
    const context = specs.get('bob')?.contextText ?? '';

    expect(context).toContain('The app loaded compact startup context');
    expect(context).toContain('Current task briefing:');
    expect(context).not.toContain('Actionable:');
    expect(context).not.toContain('RUNNING_SENTINEL');
    expect(context).not.toContain('PENDING_SENTINEL');
    expect(context).toContain('No Actionable work is loaded in this startup context');
  });
});
