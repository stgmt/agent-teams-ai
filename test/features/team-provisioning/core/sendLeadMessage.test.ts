import { describe, expect, it, vi } from 'vitest';

import { SendLeadMessage } from '../../../../src/features/team-provisioning/core/application/commands/SendLeadMessage';
import { createMemberLifecycle } from '../../../../src/features/team-provisioning/main/composition/createMemberLifecycle';

import type { MemberRuntimeEvents } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};
const run = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };
const roster = [
  { memberName: 'team-lead', role: 'lead' as const },
  { memberName: 'builder', role: 'member' as const },
];

function setup() {
  const writes: { name: string; line: string }[] = [];
  const lifecycle = createMemberLifecycle({
    owner,
    settings: {
      async findConfiguredMember(team, memberName) {
        return {
          team,
          memberName,
          configurationRevision: 'TEST-revision',
          providerId: 'anthropic',
          model: 'TEST-model',
          workingDirectory: 'TEST-project',
          instructions: 'TEST',
        };
      },
    },
    runtime: {
      async spawn(settings) {
        let events!: MemberRuntimeEvents;
        return {
          identity: {
            pid: settings.memberName === 'team-lead' ? 100 : 101,
            birthId: 'TEST-' + settings.memberName,
          },
          subscribe(listener) {
            events = listener;
            listener.connected();
            return () => undefined;
          },
          async stop() {
            events.exited({ code: 0, signal: null });
            events.released();
          },
          async writeInput(line) {
            writes.push({ name: settings.memberName, line });
          },
        };
      },
    },
  });
  const encode = vi.fn(
    async (text: string, _run: typeof run, _attachments: readonly { data: string }[]) =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  );
  const send = new SendLeadMessage({
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    write: (token, line) => lifecycle.commands.writeInput(token, line),
    encode,
  });
  return { lifecycle, send, writes, encode };
}

async function launched(lifecycle: ReturnType<typeof setup>['lifecycle']) {
  await lifecycle.teams.launch(run, roster);
  await Promise.all(roster.map(({ memberName }) => lifecycle.commands.settled(run, memberName)));
}

describe('generation-bound lead message delivery', () => {
  it('sends the user message only to the configured current lead, never to another member', async () => {
    const { lifecycle, send, writes, encode } = setup();
    await launched(lifecycle);
    await send.execute(run, 'TEST user message');
    expect(writes).toEqual([
      {
        name: 'team-lead',
        line: JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'TEST user message' }] },
        }),
      },
    ]);
    expect(encode).toHaveBeenCalledWith('TEST user message', run, []);
  });

  it('preserves an attachment-only message as detached immutable input during asynchronous encoding', async () => {
    const { lifecycle, send, encode } = setup();
    await launched(lifecycle);
    const attachment = {
      id: 'TEST-image',
      filename: 'TEST.png',
      mimeType: 'image/png',
      size: 4,
      data: 'VEVTVA==',
    };
    let release!: (line: string) => void;
    encode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const sending = send.execute(run, '', [attachment]);
    await expect.poll(() => encode.mock.calls.length).toBe(1);
    const captured = encode.mock.calls[0][2];
    expect(captured).toEqual([attachment]);
    expect(captured![0]).not.toBe(attachment);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured![0])).toBe(true);
    attachment.data = 'V1JPTkc=';
    expect(captured![0].data).toBe('VEVTVA==');
    release('TEST-attachment-frame');
    await sending;
  });

  it('rejects an empty message with no attachments before preparing input', async () => {
    const { lifecycle, send, encode } = setup();
    await launched(lifecycle);
    await expect(send.execute(run, '  ', [])).rejects.toThrow('empty');
    expect(encode).not.toHaveBeenCalled();
  });

  it('rechecks the attempt after asynchronous attachment encoding instead of writing to a stopped run', async () => {
    const { lifecycle, send, writes, encode } = setup();
    await launched(lifecycle);
    let release!: (line: string) => void;
    encode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const sending = send.execute(run, 'TEST pending message');
    const rejected = expect(sending).rejects.toThrow('current');
    await expect.poll(() => encode.mock.calls.length).toBe(1);
    await lifecycle.teams.stop(run);
    release('TEST-payload');
    await rejected;
    expect(writes).toEqual([]);
  });

  it('rejects a foreign run or an absent lead before preparing a payload', async () => {
    const { lifecycle, send, encode } = setup();
    await launched(lifecycle);
    await expect(send.execute({ ...run, connectionGeneration: 2 }, 'TEST')).rejects.toThrow(
      'current'
    );
    await lifecycle.commands.stop(run, 'team-lead');
    await expect(send.execute(run, 'TEST')).rejects.toThrow('lead');
    expect(encode).not.toHaveBeenCalled();
  });
});
