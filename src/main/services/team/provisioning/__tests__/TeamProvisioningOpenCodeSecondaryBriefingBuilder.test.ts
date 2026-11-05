import { protocols } from 'agent-teams-controller';
import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts,
  createTeamProvisioningOpenCodeSecondaryBriefingBuilder,
  type OpenCodeSecondaryBriefingBuilderPorts,
} from '../TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import type { TeamTask } from '@shared/types';

function createPorts(
  briefing: unknown,
  tasks: TeamTask[] = []
): {
  createController: ReturnType<typeof vi.fn>;
  getClaudeBasePath: ReturnType<typeof vi.fn>;
  memberBriefing: ReturnType<typeof vi.fn>;
  readTasks: ReturnType<typeof vi.fn>;
  ports: OpenCodeSecondaryBriefingBuilderPorts;
} {
  const memberBriefing = vi.fn(async () => briefing);
  const createController = vi.fn(() => ({
    taskBoard: {
      memberBriefing,
    },
    tasks: {
      memberBriefing,
    },
  }));
  const getClaudeBasePath = vi.fn(() => '/home/test/.claude');
  const readTasks = vi.fn(async () => tasks);

  return {
    createController,
    getClaudeBasePath,
    memberBriefing,
    readTasks,
    ports: {
      createController,
      getClaudeBasePath,
      readTasks,
    },
  };
}

describe('TeamProvisioningOpenCodeSecondaryBriefingBuilder', () => {
  it('loads the OpenCode member briefing through the controller port and wraps it for launch', async () => {
    const fullTask: TeamTask = {
      id: '1',
      displayId: '1',
      subject: 'Builder job',
      description: 'Complete project details retained in the registry snapshot.',
      prompt: 'Full assigned instruction.',
      comments: [
        {
          id: 'comment-1',
          author: 'Lead',
          text: 'Keep this comment intact.',
          createdAt: '2026-11-05T00:00:00.000Z',
          type: 'regular',
        },
      ],
      status: 'pending',
    };
    const { createController, getClaudeBasePath, memberBriefing, readTasks, ports } = createPorts(
      '  Builder briefing\nBearer ABCDEFGHIJKLMNOP  ',
      [fullTask]
    );
    const builder = createTeamProvisioningOpenCodeSecondaryBriefingBuilder(ports);

    const prompt = await builder.buildOpenCodeSecondaryAppManagedLaunchPrompt({
      teamName: 'atlas-hq',
      memberName: 'Builder',
    });

    expect(readTasks).toHaveBeenCalledTimes(1);
    expect(readTasks).toHaveBeenCalledWith('atlas-hq');
    expect(getClaudeBasePath).toHaveBeenCalledTimes(1);
    expect(createController).toHaveBeenCalledWith({
      teamName: 'atlas-hq',
      claudeDir: '/home/test/.claude',
      allowUserMessageSender: false,
      readOnlyTaskSnapshot: [fullTask],
    });
    expect(memberBriefing).toHaveBeenCalledWith('Builder', {
      runtimeProvider: 'opencode',
      includeActiveProcesses: false,
      includeChatVisualizationProtocol: false,
    });
    expect(prompt).toBe(
      [
        '<agent_teams_app_managed_briefing_source>',
        'This briefing was loaded by the desktop app via member_briefing with includeActiveProcesses=false.',
        'Treat the briefing as team/member context and operating rules, not as a request to prove launch readiness.',
        'Builder briefing\nBearer [redacted]',
        '',
        protocols.buildChatVisualizationProtocolText(),
        '</agent_teams_app_managed_briefing_source>',
      ].join('\n')
    );
  });

  it('rejects an empty bounded briefing with the member name in the diagnostic', async () => {
    const { ports } = createPorts(' \r\n ');

    await expect(
      buildOpenCodeSecondaryAppManagedLaunchPromptWithPorts(
        {
          teamName: 'atlas-hq',
          memberName: 'Builder',
        },
        ports
      )
    ).rejects.toThrow('OpenCode app-managed member briefing was empty for Builder');
  });
});
