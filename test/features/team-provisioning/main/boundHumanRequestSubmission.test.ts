// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createBoundHumanRequestSubmission } from '../../../../src/features/team-provisioning/main/composition/createBoundHumanRequestSubmission';

import type { TeamRunIdentity } from '../../../../src/features/team-provisioning/contracts';

// РИСК: controlled persistence/input port proves admission and physical drain, not an Electron or native CLI run.
function setup() {
  const context = new BoundControlContext('TEST-app', 'TEST-root');
  const owner = context.snapshot();
  const submit = vi.fn<
    (
      run: Readonly<TeamRunIdentity>,
      id: string,
      text: string
    ) => Promise<{ requestMessageId: string; state: 'sent' }>
  >((_run, id) => Promise.resolve({ requestMessageId: id, state: 'sent' }));
  const admitted = vi.fn();
  const released = vi.fn();
  const submission = createBoundHumanRequestSubmission({
    owner,
    submit,
    invalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      admitted();
      try {
        return await operation();
      } finally {
        release();
        released();
      }
    },
  });
  const request = {
    expectedContext: owner,
    teamName: 'test-team',
    runId: 'TEST-run',
    requestMessageId: 'TEST-human',
    text: 'An original human question',
  };
  return { context, owner, submit, admitted, released, submission, request };
}

describe('context-bound original human request submission', () => {
  it('passes only a frozen exact run and detached human primitives into the existing submission owner', async () => {
    const { submission, request, submit, owner, admitted, released } = setup();
    await expect(submission.submit(request)).resolves.toEqual({
      requestMessageId: request.requestMessageId,
      state: 'sent',
    });
    expect(submit).toHaveBeenCalledWith(
      { ...owner, teamName: request.teamName, runId: request.runId },
      request.requestMessageId,
      request.text
    );
    expect(Object.isFrozen(submit.mock.calls[0][0])).toBe(true);
    expect(admitted).toHaveBeenCalledOnce();
    expect(released).toHaveBeenCalledOnce();
  });

  it.each([
    { provider: 'TEST-other' },
    { model: 'TEST-other' },
    { cwd: 'TEST-other' },
    { origin: { kind: 'service' } },
    { isMeta: true },
    { credential: 'TEST-lead' },
    { attachments: [] },
    { teamName: '../other' },
    { teamName: ' test-team' },
    { runId: '' },
    { runId: ' TEST-run' },
    { runId: 'x'.repeat(129) },
    { runId: 'TEST-\nrun' },
    { requestMessageId: '' },
    { requestMessageId: ' TEST-human' },
    { requestMessageId: 'x'.repeat(257) },
    { requestMessageId: 'TEST-\nhuman' },
    { text: '' },
    { text: '   ' },
    { text: 'x'.repeat(64_001) },
    { text: null },
  ])(
    'rejects invalid or caller-selected admission fields before side effects: %j',
    async (fields) => {
      const { submission, request, submit, admitted } = setup();
      await expect(submission.submit({ ...request, ...fields })).rejects.toThrow();
      expect(submit).not.toHaveBeenCalled();
      expect(admitted).not.toHaveBeenCalled();
    }
  );

  it('rejects a foreign or replaced connection before persistence', async () => {
    const { submission, request, context, submit } = setup();
    await expect(
      submission.submit({
        ...request,
        expectedContext: { ...request.expectedContext, appInstanceId: 'TEST-other' },
      })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    context.transportReplaced();
    await expect(submission.submit(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(submit).not.toHaveBeenCalled();
  });

  it('drains an admitted write before returning context mismatch and releasing root admission', async () => {
    const { submission, request, context, submit, released } = setup();
    let finish!: () => void;
    const written = new Promise<void>((resolve) => {
      finish = resolve;
    });
    submit.mockImplementationOnce(async (_run, id) => {
      await written;
      return { requestMessageId: id, state: 'sent' };
    });
    const pending = submission.submit(request);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    context.transportReplaced();
    let settled = false;
    const result = pending.finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(released).not.toHaveBeenCalled();
    finish();
    await rejected;
    expect(released).toHaveBeenCalledOnce();
  });

  it('does not let root rebind pass a still-pending submission after admission closes', async () => {
    const { submission, request, context, submit, released } = setup();
    let finish!: () => void;
    const written = new Promise<void>((resolve) => {
      finish = resolve;
    });
    submit.mockImplementationOnce(async (_run, id) => {
      await written;
      return { requestMessageId: id, state: 'sent' };
    });
    const pending = submission.submit(request);
    const rejected = expect(pending).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    let drained = false;
    const closing = context.closeAdmission().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(released).not.toHaveBeenCalled();
    expect(() => context.rebind('TEST-other-root')).toThrow('admitted control requests');
    finish();
    await rejected;
    await closing;
    expect(drained).toBe(true);
    context.rebind('TEST-other-root');
    await expect(submission.submit(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(submit).toHaveBeenCalledOnce();
  });

  it('keeps the original input when the caller mutates its request during admission', async () => {
    const { submission, request, submit } = setup();
    const pending = submission.submit(request);
    request.text = 'Changed by caller';
    request.runId = 'TEST-successor';
    await pending;
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'TEST-run' }),
      'TEST-human',
      'An original human question'
    );
  });

  it('preserves a current-run failure and maps an invalidated pending failure only after it drains', async () => {
    const { submission, request, context, submit, released } = setup();
    submit.mockRejectedValueOnce(new Error('TEST history corrupt'));
    await expect(submission.submit(request)).rejects.toThrow('TEST history corrupt');
    submit.mockImplementationOnce(() => {
      context.transportReplaced();
      return Promise.reject(new Error('TEST interrupted persistence'));
    });
    await expect(submission.submit(request)).rejects.toThrow('APP_CONTEXT_MISMATCH');
    expect(released).toHaveBeenCalledTimes(2);
  });
});
