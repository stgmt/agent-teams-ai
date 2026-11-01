// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeMemberIdentity } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberIdentity';
import {
  getOpenCodeRuntimeLaneIndexPath,
  getOpenCodeRuntimeManifestPath,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createDefaultRuntimeStoreManifest } from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';

import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';
const created: string[] = [];

async function teamsBasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'native-identity-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(team: string, activeRunId: string | null) {
  return { ...createDefaultRuntimeStoreManifest(team, '2026-11-01T00:00:00.000Z'), activeRunId };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), 'utf8');
}

function config(providerId: string | undefined): TeamConfig {
  return {
    name: 'Alpha',
    projectPath: '/TEST/alpha',
    members: [
      { name: 'team-lead', agentType: 'team-lead', providerId } as never,
      { name: 'builder', agentType: 'general-purpose', providerId } as never,
    ],
  } as never;
}

describe('native OpenCode member identity', () => {
  it('resolves a member to a lane when the team was configured with OpenCode', async () => {
    const identity = await createNativeOpenCodeMemberIdentity({
      teamsBasePath: '/TEST/teams',
      readConfig: async () => config('opencode'),
    }).resolveOpenCodeMemberDeliveryIdentity(teamName, 'builder');

    expect(identity.ok).toBe(true);
    if (!identity.ok) throw new Error('expected a resolvable identity');
    expect(identity.canonicalMemberName).toBe('builder');
    expect(identity.laneId).toBe('primary');
  });

  it('refuses a member of a team that is not OpenCode', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: '/TEST/teams',
      readConfig: async () => config('claude'),
    });

    await expect(
      subject.resolveOpenCodeMemberDeliveryIdentity(teamName, 'builder')
    ).resolves.toMatchObject({ ok: false, reason: 'recipient_is_not_opencode' });
    await expect(subject.isOpenCodeRuntimeRecipient(teamName, 'builder')).resolves.toBe(false);
  });

  it('uses persisted launch metadata to place a member without its own provider entry', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: '/TEST/teams',
      // A team launched as OpenCode records the provider once, not per member.
      readConfig: async () =>
        ({
          name: 'Alpha',
          projectPath: '/TEST/alpha',
          members: [
            { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' },
            {
              name: 'builder',
              agentType: 'general-purpose',
              provider: 'opencode',
            } as never,
          ],
        }) as never,
      readTeamMeta: async () => ({ launchIdentity: { providerId: 'opencode' } }),
    });

    await expect(subject.isOpenCodeRuntimeRecipient(teamName, 'builder')).resolves.toBe(true);
  });

  it('reports an unknown member as unavailable rather than guessing a lane', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: '/TEST/teams',
      readConfig: async () => config('opencode'),
    });

    await expect(
      subject.resolveOpenCodeMemberDeliveryIdentity(teamName, 'nobody')
    ).resolves.toMatchObject({ ok: false, reason: 'opencode_recipient_unavailable' });
  });
});

describe('native OpenCode run resolution', () => {
  it('prefers the in-memory run over disk evidence', async () => {
    const base = await teamsBasePath();
    await writeJson(getOpenCodeRuntimeLaneIndexPath(base, teamName), {
      version: 1,
      updatedAt: '2026-11-01T00:00:00.000Z',
      lanes: { primary: { laneId: 'primary', state: 'active', updatedAt: 'x' } },
    });
    await writeJson(
      getOpenCodeRuntimeManifestPath(base, teamName, 'primary'),
      manifest(teamName, 'run-on-disk')
    );

    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: base,
      readConfig: async () => null,
      getCurrentOpenCodeRuntimeRunId: (team, lane) =>
        team === teamName && lane === 'primary' ? 'run-in-memory' : null,
    });

    await expect(subject.resolveCurrentOpenCodeRuntimeRunId(teamName, 'primary')).resolves.toBe(
      'run-in-memory'
    );
  });

  it('falls back to the persisted run of an active lane', async () => {
    const base = await teamsBasePath();
    await writeJson(getOpenCodeRuntimeLaneIndexPath(base, teamName), {
      version: 1,
      updatedAt: '2026-11-01T00:00:00.000Z',
      lanes: {
        primary: { laneId: 'primary', state: 'active', updatedAt: 'x' },
        'secondary:opencode:builder': {
          laneId: 'secondary:opencode:builder',
          state: 'stopped',
          updatedAt: 'x',
        },
      },
    });
    await writeJson(
      getOpenCodeRuntimeManifestPath(base, teamName, 'primary'),
      manifest(teamName, 'run-primary')
    );
    await writeJson(
      getOpenCodeRuntimeManifestPath(base, teamName, 'secondary:opencode:builder'),
      manifest(teamName, 'run-secondary')
    );

    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: base,
      readConfig: async () => null,
    });

    await expect(subject.resolveCurrentOpenCodeRuntimeRunId(teamName, 'primary')).resolves.toBe(
      'run-primary'
    );
    await expect(subject.isOpenCodeRuntimeLaneIndexActive(teamName, 'primary')).resolves.toBe(true);
    // A stopped lane keeps its manifest, but its run must not be offered for delivery.
    await expect(
      subject.resolveCurrentOpenCodeRuntimeRunId(teamName, 'secondary:opencode:builder')
    ).resolves.toBeNull();
    await expect(
      subject.isOpenCodeRuntimeLaneIndexActive(teamName, 'secondary:opencode:builder')
    ).resolves.toBe(false);
  });

  it('treats a missing lane index as no lane at all', async () => {
    const base = await teamsBasePath();
    const subject = createNativeOpenCodeMemberIdentity({
      teamsBasePath: base,
      readConfig: async () => null,
    });

    await expect(subject.resolveCurrentOpenCodeRuntimeRunId(teamName, 'primary')).resolves.toBeNull();
    await expect(subject.isOpenCodeRuntimeLaneIndexActive(teamName, 'primary')).resolves.toBe(
      false
    );
  });
});
