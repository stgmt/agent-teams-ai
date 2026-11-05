import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { registryOnlyTaskControlFixture } from './helpers/registryOnlyTaskControlFixture';
import {
  createRegistryTaskTestBoundary,
  type RegistryTaskTestBoundary,
} from './helpers/registryTaskTestBoundary';

const requireFromTest = createRequire(import.meta.url);
const desktopBinding = requireFromTest(
  '../../../../agent-teams-controller/src/internal/desktopControlBinding.js'
) as { isDesktopBound: () => boolean };

describe('bounded OpenCode startup visualization briefing', () => {
  const claudeDir = registryOnlyTaskControlFixture.claudeDir;
  const teamName = 'visualization-test-team';
  let registryBoundary: RegistryTaskTestBoundary | undefined;
  let restoreDesktopBinding: (() => void) | undefined;

  afterEach(async () => {
    restoreDesktopBinding?.();
    restoreDesktopBinding = undefined;
    if (registryBoundary) {
      await registryBoundary.dispose();
      registryBoundary = undefined;
    }
    await registryOnlyTaskControlFixture.clearTeam(teamName);
  });
  afterAll(() => registryOnlyTaskControlFixture.dispose());
  it('keeps operating rules and workflow context within12k using an atomic display refresh for a long real briefing', async () => {
    // Both controller calls use a real read-only snapshot from an isolated registry boundary.
    const { buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts } = await import(
      '@main/services/team/provisioning/TeamProvisioningOpenCodeSecondaryBriefingBuilder'
    );
    const teamDir = join(claudeDir, 'teams', teamName);
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      join(teamDir, 'config.json'),
      JSON.stringify({
        name: teamName,
        specProject: 'sandbox/project',
        specSlug: 'sandbox-spec',
        projectPath: join(claudeDir, 'sandbox-project'),
        members: [
          { name: 'lead', agentType: 'team-lead' },
          {
            name: 'Builder',
            agentType: 'team-member',
            role: 'Visualization reviewer',
            workflow: 'Ordinary task context. '.repeat(1500),
          },
        ],
      })
    );
    const boundary = await createRegistryTaskTestBoundary({ teamName });
    registryBoundary = boundary;
    const readOnlyTaskSnapshot = await boundary.taskReader.getTasks(teamName);
    // This fixture does not implement group-chat listing; keep this briefing test focused on
    // its task snapshot and visualization behavior via the controller's unbound fallback.
    const wasDesktopBound = desktopBinding.isDesktopBound;
    desktopBinding.isDesktopBound = () => false;
    restoreDesktopBinding = () => {
      desktopBinding.isDesktopBound = wasDesktopBound;
    };
    const controller = registryOnlyTaskControlFixture.createController({
      teamName,
      claudeDir,
      allowUserMessageSender: false,
      readOnlyTaskSnapshot,
    });
    const rawBriefing = await controller.taskBoard.memberBriefing('Builder', {
      runtimeProvider: 'opencode',
      includeActiveProcesses: false,
      includeChatVisualizationProtocol: false,
    });
    const protocol = registryOnlyTaskControlFixture.protocols.buildChatVisualizationProtocolText();
    expect(rawBriefing.length).toBeGreaterThan(12_000);
    expect(rawBriefing).not.toContain(protocol);
    const prompt = await buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(
      { teamName, memberName: 'Builder' },
      {
        createController: (input) => registryOnlyTaskControlFixture.createController(input),
        getClaudeBasePath: () => claudeDir,
        readTasks: (candidateTeamName) => boundary.taskReader.getTasks(candidateTeamName),
      }
    );
    expect(prompt.length).toBeLessThanOrEqual(12_000);
    expect(prompt).not.toContain(protocol);
    expect(prompt).not.toContain('AVAILABLE DISPLAY LIBRARY SPEC');
    expect(prompt).toContain(
      registryOnlyTaskControlFixture.protocols.buildChatVisualizationRefreshInstruction()
    );
    expect(prompt.match(/CHAT VISUALIZATION REFRESH REQUIRED/g)).toHaveLength(1);
    expect(prompt).toContain('Role: Visualization reviewer.');
    expect(prompt).toContain('task_add_comment BEFORE calling task_complete');
    expect(prompt).toContain('OpenCode bootstrap silence rule');
    expect(prompt).toContain('Ordinary task context.');
    expect(prompt).toContain('not as a request to prove launch readiness.');
    expect(prompt.endsWith('</agent_teams_app_managed_briefing_source>')).toBe(true);
  });
});
