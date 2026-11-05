import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registryOnlyTaskControlFixture } from '../../../../../../test/main/services/team/helpers/registryOnlyTaskControlFixture';
import {
  createRegistryTaskTestBoundary,
  type RegistryTaskTestBoundary,
} from '../../../../../../test/main/services/team/helpers/registryTaskTestBoundary';

import type { deliverStartupWorkAfterConfirmation as DeliverStartupWorkAfterConfirmation } from '../TeamProvisioningStartupWorkDelivery';
import type { TeamTask } from '@shared/types';

// A bound local app-control API provides canonical task rows without using the user's registry.
let deliverStartupWorkAfterConfirmation: typeof DeliverStartupWorkAfterConfirmation;
let registryBoundary: RegistryTaskTestBoundary;

beforeAll(async () => {
  // The delivery module imports the controller via its bootstrap provider; load it after binding.
  const module = await import('../TeamProvisioningStartupWorkDelivery');
  deliverStartupWorkAfterConfirmation = module.deliverStartupWorkAfterConfirmation;
});

interface InboxRow {
  messageId?: string;
  read?: boolean;
  summary?: string;
  text?: string;
}

describe('startup work delivery after a confirmed launch', () => {
  let claudeDir = '';
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  let registryTasks: TeamTask[] = [];

  const teamDir = () => join(claudeDir, 'teams', 'fixture');
  const inbox = (member: string): InboxRow[] => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as InboxRow[]) : [];
  };
  const startupRows = (member: string) =>
    inbox(member).filter((row) => String(row.messageId).startsWith('startup-work:'));
  const markInboxRead = (member: string) => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    if (!existsSync(file)) return;
    writeFileSync(file, JSON.stringify(inbox(member).map((row) => ({ ...row, read: true }))));
  };

  const run = (members: { name: string; providerId?: string }[]) => ({
    runId: 'run-1',
    teamName: 'fixture',
    allEffectiveMembers: members.map((member) => ({ ...member, role: 'developer' })),
  });

  const deliver = (
    memberName: string,
    launchAttemptId: string,
    members = [{ name: 'bob' }, { name: 'carol', providerId: 'opencode' }],
    readTasks = (teamName: string) => registryBoundary.taskReader.getTasks(teamName),
    isCurrent = () => true
  ) =>
    deliverStartupWorkAfterConfirmation(run(members) as never, memberName, launchAttemptId, {
      createController: (input) => registryOnlyTaskControlFixture.createController(input),
      readTasks,
      getClaudeBasePath: () => claudeDir,
      isCurrent,
      appendMemberBootstrapDiagnostic: (_run, member, text) =>
        diagnostics.push(`${member}: ${text}`),
      logger: { warn: (message: string) => warnings.push(message) },
    });

  beforeEach(async () => {
    claudeDir = registryOnlyTaskControlFixture.claudeDir;
    await registryOnlyTaskControlFixture.clearTeam('fixture');
    registryBoundary = await createRegistryTaskTestBoundary({ teamName: 'fixture' });
    registryTasks = [];
    mkdirSync(teamDir(), { recursive: true });
    writeFileSync(
      join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        specProject: 'sandbox/project',
        specSlug: 'sandbox-spec',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
          { name: 'carol', role: 'developer', providerId: 'opencode' },
        ],
      })
    );
    diagnostics.length = 0;
    warnings.length = 0;
  });

  afterEach(async () => {
    await registryOnlyTaskControlFixture.clearTeam('fixture');
    await registryBoundary.dispose();
  });
  afterAll(() => registryOnlyTaskControlFixture.dispose());

  const board = () =>
    registryOnlyTaskControlFixture.createController({ teamName: 'fixture', claudeDir }).taskBoard;
  const createTask = async (subject: string, owner: string) => {
    const task = board().createTask({ requirements: ['FR-1'], subject, owner });
    const createdTask = task as { id: string };
    registryOnlyTaskControlFixture.trackTask('fixture', String(createdTask.id));
    registryTasks.push({
      id: String(createdTask.id),
      displayId: String(createdTask.id),
      subject,
      owner,
      status: 'pending',
      createdAt: '2026-10-22T10:00:00.000Z',
      updatedAt: '2026-10-22T10:00:00.000Z',
    });
    await registryBoundary.replaceTasks(registryTasks);
    return task;
  };

  it('S1.3: a native member gets its tasks as messages with a delivery count', async () => {
    await createTask('First job', 'bob');
    const second = await createTask('Second job', 'bob');
    const secondId = String((second as { id: string }).id);
    board().startTask(secondId, 'bob');
    registryTasks = registryTasks.map((task) =>
      task.id === secondId ? { ...task, status: 'in_progress' } : task
    );
    await registryBoundary.replaceTasks(registryTasks);
    markInboxRead('bob');

    const deliveredCount = await deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(deliveredCount).toBe(2);
    expect(startupRows('bob')).toHaveLength(2);
    expect(startupRows('bob').every((row) => row.read === false)).toBe(true);
    expect(diagnostics).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('S1.17: an OpenCode member is left alone (its briefing keeps the task queue)', async () => {
    await createTask('OpenCode job', 'carol');
    markInboxRead('carol');

    await deliver('carol', 'run-1@2026-10-22T10:00:00.000Z');

    expect(startupRows('carol')).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('does not read or deliver after the connection generation becomes stale', async () => {
    const count = await deliver(
      'bob',
      'run-1-generation-1-operation-1',
      undefined,
      async () => {
        throw new Error('stale delivery must not read the task registry');
      },
      () => false
    );

    expect(count).toBe(0);
    expect(inbox('bob')).toEqual([]);
    expect(warnings).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('a member with no work gets nothing and no diagnostic noise', async () => {
    await deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(inbox('bob')).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('S1.12: the same launch attempt delivers once', async () => {
    await createTask('Only once', 'bob');
    markInboxRead('bob');

    await deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');
    markInboxRead('bob');
    await deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(startupRows('bob')).toHaveLength(1);
  });

  it('S1.18: a restart inside the same run is a new launch attempt and delivers again', async () => {
    await createTask('Survives a restart', 'bob');
    markInboxRead('bob');

    await deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');
    markInboxRead('bob');
    await deliver('bob', 'run-1@2026-10-22T10:20:00.000Z');

    expect(startupRows('bob')).toHaveLength(2);
    expect(startupRows('bob')[1]?.read).toBe(false);
  });

  it('S1.19: delivery failures are logged, diagnosed, and returned to the retry owner', async () => {
    // The member is in the run but not in the team config: the controller refuses it.
    await expect(
      deliver('stranger', 'run-1@2026-10-22T10:00:00.000Z', [{ name: 'stranger' }])
    ).rejects.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stranger');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^stranger: .*(failed|could not)/i);
  });

  it('propagates and diagnoses registry read failures rather than delivering from an empty queue', async () => {
    const error = new Error('task registry unavailable');

    await expect(
      deliver('bob', 'run-1@2026-10-22T10:00:00.000Z', undefined, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(diagnostics).toEqual([
      'bob: startup work delivery failed after launch confirmation for run-1@2026-10-22T10:00:00.000Z: task registry unavailable',
    ]);
    expect(warnings).toEqual([
      '[fixture] Startup work delivery failed for "bob" (run-1@2026-10-22T10:00:00.000Z): task registry unavailable',
    ]);
  });
});
