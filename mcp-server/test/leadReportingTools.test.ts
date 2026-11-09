import { describe, expect, it, vi } from 'vitest';

const { sendMessage, leadBriefing } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  leadBriefing: vi.fn(),
}));
vi.mock('../src/controller', () => ({
  getController: () => ({ messages: { sendMessage }, taskBoard: { leadBriefing } }),
}));
vi.mock('../src/utils/teamConfig', () => ({ assertConfiguredTeam: vi.fn() }));

import { registerLeadTools } from '../src/tools/leadTools';
import { registerMessageTools } from '../src/tools/messageTools';

interface Tool {
  name: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute(args: Record<string, unknown>): Promise<{ content: { text: string }[] }>;
}

function tools() {
  const registered = new Map<string, Tool>();
  const server = { addTool: (tool: Tool) => registered.set(tool.name, tool) };
  registerLeadTools(server as never);
  registerMessageTools(server as never);
  return registered;
}

describe('report fields and confirmed delivery through existing MCP tools', () => {
  it('awaits controller delivery instead of reporting success for an unresolved promise', async () => {
    let resolve!: (value: unknown) => void;
    sendMessage.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const tool = tools().get('message_send')!;
    const report = {
      inspectionId: 'test-inspection',
      summary: 'Checkout is unfinished',
      members: [
        {
          memberName: 'worker',
          statements: [
            {
              kind: 'observation',
              text: 'Unfinished checkout task',
              evidenceIds: ['test-evidence'],
            },
          ],
        },
      ],
      nextStep: 'Review checkout',
    };
    expect(
      tool.parameters.safeParse({
        teamName: 'test-team',
        from: 'team-lead',
        to: 'user',
        text: report.summary,
        report,
      }).success
    ).toBe(true);
    const sent = vi.fn();
    const pending = tool
      .execute({
        teamName: 'test-team',
        from: 'team-lead',
        to: 'user',
        text: report.summary,
        report,
      })
      .then(sent);
    await Promise.resolve();
    expect(sent).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ report }));
    resolve({ messageId: 'test-delivered', requestMessageId: 'test-request' });
    await pending;
    expect(JSON.parse(sent.mock.calls[0][0].content[0].text)).toMatchObject({
      messageId: 'test-delivered',
      requestMessageId: 'test-request',
    });
  });

  it('forwards the exact app-admitted request identity for an ordinary reply', async () => {
    sendMessage.mockResolvedValueOnce({ messageId: 'reply-1', requestMessageId: 'request-42' });
    const tool = tools().get('message_send')!;
    const input = {
      teamName: 'test-team',
      from: 'team-lead',
      to: 'user',
      text: 'The work is underway.',
      requestMessageId: 'request-42',
    };
    expect(tool.parameters.safeParse(input).success).toBe(true);
    const result = await tool.execute(input);
    expect(sendMessage).toHaveBeenLastCalledWith({
      from: 'team-lead',
      to: 'user',
      text: input.text,
      requestMessageId: input.requestMessageId,
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      messageId: 'reply-1',
      requestMessageId: 'request-42',
    });
  });

  it('keeps source errors as errors, not successful delivered messages', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Report sources changed; inspect again'));
    await expect(
      tools()
        .get('message_send')!
        .execute({ teamName: 'test-team', from: 'team-lead', to: 'user', text: 'test' })
    ).rejects.toThrow('changed');
  });

  it('returns the structured inspection without replacing evidence with a generic readiness line', async () => {
    const facts = JSON.stringify({
      inspection: {
        members: [
          {
            name: 'worker',
            process: { phase: 'exited', everConnected: true },
            tasks: [{ subject: 'Checkout needs fixes' }],
          },
        ],
      },
    });
    leadBriefing.mockResolvedValueOnce(facts);
    expect(
      (await tools().get('lead_briefing')!.execute({ teamName: 'test-team' })).content[0].text
    ).toBe(facts);
  });
});
