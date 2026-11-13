// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { NativeTeamTaskLedgerReader } from '../../../../src/features/team-provisioning/main/adapters/output/NativeTeamTaskLedgerReader';
import { NodeTeamWorkspace } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamWorkspace';
import { createBoundLifecycleQueries } from '../../../../src/features/team-provisioning/main/composition/createBoundLifecycleQueries';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';
import { nativeTeamTaskLedgerProjectDirectory } from '../../../../src/features/team-provisioning/main/infrastructure/nativeTeamTaskLedger';
import { TaskChangeLedgerReader } from '../../../../src/main/services/team/TaskChangeLedgerReader';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'TEST-native-task-ledger-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function setup() {
  const context = new BoundControlContext('TEST-app', root);
  const run = { ...context.snapshot(), teamName: 'test-ledger-team', runId: 'TEST-run' };
  const lifecycle = createMemberLifecycle({
    owner: context.snapshot(),
    settings: { findConfiguredMember: () => Promise.resolve(null) },
    runtime: { spawn: () => Promise.reject(new Error('TEST no child process')) },
  });
  await lifecycle.teams.launch(run, [{ memberName: 'team-lead', role: 'lead' }]);
  const queries = createBoundLifecycleQueries({
    owner: context.snapshot(),
    source: lifecycle.registry,
    invalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
  return { context, run, lifecycle, queries };
}

function currentReader(teamsRoot: string, queries: Awaited<ReturnType<typeof setup>>['queries']) {
  const ledger = new TaskChangeLedgerReader();
  return new NativeTeamTaskLedgerReader({
    teamsRoot,
    queries,
    reader: { readTaskChanges: (input) => ledger.readCurrentTaskChanges(input) },
  });
}

describe('native team task ledger binding', () => {
  it('uses the same explicit directory for lead/member preparation and the real ledger reader, with no project hash lookup', async () => {
    const { run, queries } = await setup();
    const teamsRoot = join(root, 'teams');
    const selected = nativeTeamTaskLedgerProjectDirectory(teamsRoot, run.teamName);
    const workspace = new NodeTeamWorkspace(join(root, 'workspaces'), (launch) =>
      Promise.resolve(nativeTeamTaskLedgerProjectDirectory(teamsRoot, launch.team.teamName))
    );
    for (const memberName of ['team-lead', 'builder']) {
      const prepared = await workspace.prepare(
        {
          team: run,
          memberName,
          configurationRevision: 'TEST',
          specIntegration: {
            scope: { projects: ['TEST/project'], bindings: [] },
            environment: {
              OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
              OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
            },
          },
          providerId: 'anthropic',
          model: null,
          workingDirectory: root,
          instructions: 'TEST',
        },
        new AbortController().signal
      );
      expect(prepared.taskLedgerProjectDirectory).toBe(selected);
    }
    const bundleDirectory = join(selected, '.board-task-changes', 'bundles');
    await mkdir(bundleDirectory, { recursive: true });
    await writeFile(
      join(bundleDirectory, 'TEST-task.json'),
      JSON.stringify({
        schemaVersion: 2,
        source: 'task-change-ledger',
        bundleKind: 'summary',
        taskId: 'TEST-task',
        generatedAt: '2026-10-29T00:00:00.000Z',
        files: [],
        totalFiles: 0,
        scope: {
          confidence: { tier: 1, label: 'high', reason: 'TEST fixture' },
          agentIds: [],
          memberNames: [],
          toolUseIds: [],
        },
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        warnings: [],
        confidence: 'high',
      })
    );
    const reader = currentReader(teamsRoot, queries);
    const result = await reader.read({
      expectedContext: run,
      teamName: run.teamName,
      taskId: 'TEST-task',
      includeDetails: false,
    });
    expect(result).toMatchObject({ teamName: run.teamName, taskId: 'TEST-task', files: [] });
    expect(nativeTeamTaskLedgerProjectDirectory(teamsRoot, 'test-other-team')).not.toBe(selected);
  });

  it('does not read the superseded bundle format in the replacement lifecycle', async () => {
    const { run, queries } = await setup();
    const teamsRoot = join(root, 'teams');
    const projectDir = nativeTeamTaskLedgerProjectDirectory(teamsRoot, run.teamName);
    const directory = join(projectDir, '.board-task-changes', 'bundles');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'TEST-task.json'),
      JSON.stringify({
        schemaVersion: 1,
        source: 'task-change-ledger',
        taskId: 'TEST-task',
        files: [],
        events: [],
        warnings: [],
        totalFiles: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        confidence: 'high',
      })
    );
    expect(
      await currentReader(teamsRoot, queries).read({
        expectedContext: run,
        teamName: run.teamName,
        taskId: 'TEST-task',
        includeDetails: false,
      })
    ).toBeNull();
  });

  it('rejects absent/stale context and invalid team input before any ledger IO', async () => {
    const { run, queries } = await setup();
    const readTaskChanges = vi.fn(() => Promise.resolve(null));
    const reader = new NativeTeamTaskLedgerReader({
      teamsRoot: join(root, 'teams'),
      queries,
      reader: { readTaskChanges },
    });
    const request = {
      expectedContext: run,
      teamName: run.teamName,
      taskId: 'TEST',
      includeDetails: false,
    };
    await expect(
      reader.read({ ...request, expectedContext: { ...run, connectionGeneration: 99 } })
    ).rejects.toThrow();
    await expect(reader.read({ ...request, teamName: 'test-absent' })).rejects.toThrow(
      'unavailable'
    );
    await expect(reader.read({ ...request, teamName: '../escape' })).rejects.toThrow('Invalid');
    expect(readTaskChanges).not.toHaveBeenCalled();
    expect(() => nativeTeamTaskLedgerProjectDirectory('relative', run.teamName)).toThrow(
      'absolute'
    );
  });

  it('does not return a result read across replacement by another authoritative run', async () => {
    const { run, lifecycle, queries } = await setup();
    let finish!: () => void;
    const readTaskChanges = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          finish = () => resolve(null);
        })
    );
    const reader = new NativeTeamTaskLedgerReader({
      teamsRoot: join(root, 'teams'),
      queries,
      reader: { readTaskChanges },
    });
    const pending = reader.read({
      expectedContext: run,
      teamName: run.teamName,
      taskId: 'TEST',
      includeDetails: false,
    });
    const rejected = expect(pending).rejects.toThrow('changed during read');
    await expect.poll(() => readTaskChanges.mock.calls.length).toBe(1);
    await lifecycle.teams.stop(run);
    await lifecycle.teams.launch({ ...run, runId: 'TEST-next' }, [
      { memberName: 'team-lead', role: 'lead' },
    ]);
    finish();
    await rejected;
  });
});
