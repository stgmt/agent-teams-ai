// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nativeSpecRegistryEnvironment, nativeSpecScope } from './nativeSdkTestHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots = vi.hoisted(() => ({ defaultTeams: '' }));
vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => roots.defaultTeams,
}));

import { NodeNativeMemberRegistration } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeMemberRegistration';
import { NodeTeamLaunchSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamLaunchSettings';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';

const directories: string[] = [];
afterEach(async () => {
  roots.defaultTeams = '';
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-selected-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-settings-root-'));
  directories.push(root);
  const selectedTeams = join(root, 'selected', 'teams');
  roots.defaultTeams = join(root, 'foreign', 'teams');
  const metadata = new TeamMetaStore();
  const members = new TeamMembersMetaStore();
  for (const [teamsRoot, model, memberName] of [
    [selectedTeams, 'TEST-selected-model', 'selected-builder'],
    [roots.defaultTeams, 'TEST-foreign-model', 'foreign-builder'],
  ]) {
    await mkdir(join(teamsRoot, run.teamName), { recursive: true });
    await metadata.writeMeta(
      run.teamName,
      { providerId: 'anthropic', model, cwd: root, createdAt: 1, specScope: nativeSpecScope },
      teamsRoot
    );
    await members.writeMembers(run.teamName, [{ name: memberName }], { teamsBasePath: teamsRoot });
  }
  return { root, selectedTeams, metadata, members };
}

describe('native canonical settings root', () => {
  it('reads both canonical documents only from the selected teams root', async () => {
    const { selectedTeams, metadata, members } = await setup();
    const settings = new NodeTeamLaunchSettings({
      teamsRoot: selectedTeams,
      metadata,
      members,
      specRegistryEnvironment: nativeSpecRegistryEnvironment,
    });
    const captured = await settings.capture(run);
    expect(captured.members).toEqual([
      { memberName: 'team-lead', role: 'lead' },
      { memberName: 'selected-builder', role: 'member' },
    ]);
    expect(await settings.findConfiguredMember(run, 'selected-builder')).toMatchObject({
      model: 'TEST-selected-model',
    });
    expect(await settings.findConfiguredMember(run, 'foreign-builder')).toBeNull();
  });

  it('does not borrow an existing foreign roster when selected member metadata is missing', async () => {
    const { selectedTeams, metadata, members } = await setup();
    await rm(join(selectedTeams, run.teamName, 'members.meta.json'));
    const settings = new NodeTeamLaunchSettings({ teamsRoot: selectedTeams, metadata, members });
    await expect(settings.capture(run)).rejects.toThrow('member metadata');
  });

  it('delivers the private startup check to the same selected root as process registration', async () => {
    const { root, selectedTeams } = await setup();
    const teamDirectory = join(selectedTeams, run.teamName);
    const foreignInbox = join(roots.defaultTeams, run.teamName, 'inboxes', 'builder.json');
    await mkdir(join(teamDirectory, 'inboxes'));
    await mkdir(join(roots.defaultTeams, run.teamName, 'inboxes'));
    const foreignBytes = JSON.stringify([{ from: 'TEST-foreign', text: 'keep' }]);
    await writeFile(foreignInbox, foreignBytes);
    await writeFile(
      join(teamDirectory, 'config.json'),
      JSON.stringify({
        name: run.teamName,
        appManagedRun: { identity: run, configurationRevision: 'TEST-revision' },
        leadAgentId: `team-lead@${run.teamName}`,
        members: [{ name: 'team-lead', agentId: `team-lead@${run.teamName}` }, { name: 'builder' }],
      })
    );
    const registration = new NodeNativeMemberRegistration({
      teamsRoot: selectedTeams,
      inbox: new TeamInboxWriter(),
      invalidate: vi.fn(),
    });
    await registration.register(
      {
        team: run,
        memberName: 'builder',
        role: 'member',
        providerId: 'anthropic',
        model: 'TEST-model',
        configurationRevision: 'TEST-revision',
        specIntegration: {
          scope: { projects: ['TEST/project'], bindings: [] },
          environment: {
            OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
            OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
          },
        },
        workingDirectory: root,
        instructions: 'TEST',
      },
      { ...run, memberName: 'builder', generation: 1, operationId: 'TEST-start' },
      { pid: 101, birthId: 'TEST-birth' },
      {
        proofToken: 'TEST-proof',
        contextHash: 'TEST-context',
        briefingHash: 'TEST-briefing',
        boundaryMs: Date.now(),
        eventsPath: join(root, 'events'),
      },
      new AbortController().signal
    );
    expect(await readFile(foreignInbox, 'utf8')).toBe(foreignBytes);
    expect(
      JSON.parse(await readFile(join(teamDirectory, 'inboxes', 'builder.json'), 'utf8'))
    ).toEqual([
      expect.objectContaining({ messageId: 'native-bootstrap-TEST-start', from: 'team-lead' }),
    ]);
  });

  it('requires an absolute root and rejects traversal before a canonical read', async () => {
    const { selectedTeams, metadata, members } = await setup();
    expect(
      () => new NodeTeamLaunchSettings({ teamsRoot: 'TEST-relative', metadata, members })
    ).toThrow('absolute');
    const readMeta = vi.spyOn(metadata, 'getMeta');
    const readMembers = vi.spyOn(members, 'getMeta');
    const settings = new NodeTeamLaunchSettings({ teamsRoot: selectedTeams, metadata, members });
    for (const teamName of ['../test-team', ' test-team ']) {
      await expect(settings.capture({ ...run, teamName })).rejects.toThrow('team name');
    }
    expect(readMeta).not.toHaveBeenCalled();
    expect(readMembers).not.toHaveBeenCalled();
  });
});
