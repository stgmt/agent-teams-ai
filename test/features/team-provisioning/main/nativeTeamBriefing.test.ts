// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNativeTeamBriefing } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamBriefing';

import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 20 });
});

function launch(
  cwd: string,
  instructions?: string,
  specInstructions?: string
): Readonly<ConfiguredMemberLaunch> {
  return {
    team: {
      appInstanceId: 'TEST-app',
      dataRootFingerprint: 'TEST-root',
      connectionGeneration: 1,
      teamName: 'TEST-team',
      runId: 'run-1',
    },
    memberName: 'Builder',
    configurationRevision: 'rev-1',
    providerId: 'anthropic',
    model: null,
    workingDirectory: cwd,
    instructions: instructions ?? '',
    ...(specInstructions ? { specInstructions } : {}),
  } as unknown as Readonly<ConfiguredMemberLaunch>;
}

describe('native team briefing', () => {
  it('appends the bound-specification recipe without exceeding the launch limit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'briefing-'));
    directories.push(cwd);
    const briefing = createNativeTeamBriefing({ readMembersMeta: async () => [] });
    const recipe = '## Specification work\nspec_patch';
    const longWorkflow = 'w'.repeat(18_000);

    const text = await briefing(launch(cwd, longWorkflow, recipe));

    expect(text.endsWith(recipe)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(18_000);
    expect(text.startsWith('w')).toBe(true);
  });

  it('keeps the briefing unchanged when the team has no bound specifications', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'briefing-'));
    directories.push(cwd);
    const briefing = createNativeTeamBriefing({ readMembersMeta: async () => [] });

    await expect(briefing(launch(cwd, 'Only the workflow.'))).resolves.toBe('Only the workflow.');
  });

  it('falls back to the configured instructions when the app bootstraps nothing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'briefing-'));
    directories.push(cwd);
    const briefing = createNativeTeamBriefing({ readMembersMeta: async () => [] });

    await expect(briefing(launch(cwd, 'You build the thing.'))).resolves.toBe(
      'You build the thing.'
    );
  });

  it('refuses to launch a member with no briefing at all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'briefing-'));
    directories.push(cwd);
    const briefing = createNativeTeamBriefing({ readMembersMeta: async () => [] });

    await expect(briefing(launch(cwd))).rejects.toThrow(/no briefing to launch with/);
  });

  it('reads the roster from the team its settings name', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'briefing-'));
    directories.push(cwd);
    const asked: string[] = [];
    const briefing = createNativeTeamBriefing({
      readMembersMeta: async (teamName) => {
        asked.push(teamName);
        return [];
      },
    });

    await briefing(launch(cwd, 'instructions'));
    expect(asked).toEqual(['TEST-team']);
  });
});
