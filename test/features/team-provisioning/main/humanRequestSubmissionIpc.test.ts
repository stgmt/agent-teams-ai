// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { TEAM_SUBMIT_HUMAN_REQUEST } from '../../../../src/features/team-provisioning/contracts';
import { registerHumanRequestSubmissionIpc } from '../../../../src/features/team-provisioning/main/adapters/input/registerHumanRequestSubmissionIpc';
import { createBoundHumanRequestSubmission } from '../../../../src/features/team-provisioning/main/composition/createBoundHumanRequestSubmission';
import { createLeadHumanRequestBridge } from '../../../../src/features/team-provisioning/preload/createLeadHumanRequestBridge';

import type { TeamRunIdentity } from '../../../../src/features/team-provisioning/contracts';
import type { InvokeIpcWithResult } from '../../../../src/features/team-provisioning/preload/createTeamMemberSettingsBridge';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

// РИСК: plain-value bridge/IPC fixtures check caller authority, not actual Electron isolation or OS processes.
function setup() {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  const submit = vi.fn<
    (
      run: Readonly<TeamRunIdentity>,
      id: string,
      text: string
    ) => Promise<{ requestMessageId: string; state: 'sent' | 'delivered' }>
  >((_run, id) => Promise.resolve({ requestMessageId: id, state: 'sent' }));
  const submission = createBoundHumanRequestSubmission({
    owner,
    submit,
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
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  };
  let destroyed = false;
  const sender = { mainFrame: {}, isDestroyed: () => destroyed };
  let current: typeof sender | null = sender;
  const dispose = registerHumanRequestSubmissionIpc(
    ipc,
    submission,
    () => current as unknown as WebContents | null
  );
  const invoke = async (
    channel: string,
    input: unknown,
    from = sender,
    frame: unknown = from.mainFrame
  ) =>
    await handlers.get(channel)!(
      { sender: from, senderFrame: frame } as unknown as IpcMainInvokeEvent,
      input
    );
  const bridge = createLeadHumanRequestBridge(invoke as InvokeIpcWithResult);
  const request = {
    expectedContext: owner,
    teamName: 'test-team',
    runId: 'TEST-run',
    requestMessageId: 'TEST-human',
    text: 'Original human question',
  };
  return {
    context,
    owner,
    handlers,
    sender,
    submit,
    bridge,
    invoke,
    request,
    dispose,
    destroy: () => {
      destroyed = true;
    },
    replace: () => {
      current = { ...sender };
    },
  };
}

describe('main-renderer-only human request submission', () => {
  it('returns plain sent and delivered receipts through the declared preload channel', async () => {
    const { bridge, request, submit, handlers } = setup();
    expect([...handlers.keys()]).toEqual([TEAM_SUBMIT_HUMAN_REQUEST]);
    expect(Object.keys(bridge)).toEqual(['submitHumanRequest']);
    await expect(bridge.submitHumanRequest(request)).resolves.toEqual({
      requestMessageId: request.requestMessageId,
      state: 'sent',
    });
    submit.mockResolvedValueOnce({
      requestMessageId: request.requestMessageId,
      state: 'delivered',
    });
    const receipt = await bridge.submitHumanRequest(request);
    expect(JSON.parse(JSON.stringify(receipt))).toEqual({
      requestMessageId: request.requestMessageId,
      state: 'delivered',
    });
  });

  it('rejects another renderer, subframe and absent frame before admission', async () => {
    const { invoke, request, sender, submit } = setup();
    await expect(invoke(TEAM_SUBMIT_HUMAN_REQUEST, request, { ...sender })).rejects.toThrow(
      'main renderer'
    );
    await expect(invoke(TEAM_SUBMIT_HUMAN_REQUEST, request, sender, {})).rejects.toThrow(
      'main renderer'
    );
    await expect(invoke(TEAM_SUBMIT_HUMAN_REQUEST, request, sender, null)).rejects.toThrow(
      'main renderer'
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['destroy', 'replace', 'dispose'] as const)(
    'rejects a retained invocation after %s',
    async (action) => {
      const fixture = setup();
      const handler = fixture.handlers.get(TEAM_SUBMIT_HUMAN_REQUEST)!;
      fixture[action]();
      await expect(
        Promise.resolve().then(() =>
          handler(
            {
              sender: fixture.sender,
              senderFrame: fixture.sender.mainFrame,
            } as unknown as IpcMainInvokeEvent,
            fixture.request
          )
        )
      ).rejects.toThrow('main renderer');
      expect(fixture.submit).not.toHaveBeenCalled();
      fixture.dispose();
      fixture.dispose();
      expect(fixture.handlers.size).toBe(0);
    }
  );

  it('does not let a stale context or service-origin payload cross the human boundary', async () => {
    const { bridge, request, submit, context } = setup();
    await expect(
      bridge.submitHumanRequest({ ...request, ...{ origin: { kind: 'service' } } })
    ).rejects.toThrow('Only');
    context.transportReplaced();
    await expect(bridge.submitHumanRequest(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(submit).not.toHaveBeenCalled();
  });
});
