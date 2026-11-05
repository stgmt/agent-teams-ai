// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DeliverPersistedLeadRequest } from '../../../../src/features/team-provisioning/core/application/commands/DeliverPersistedLeadRequest';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};
const persisted = {
  run,
  requestMessageId: 'TEST-human-1',
  text: 'What is the team doing?',
  origin: { kind: 'human' as const },
  isMeta: false as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// РИСК: controlled ports prove ordering/correlation, not persisted app history or model delivery.
function setup() {
  const read = vi.fn(() => Promise.resolve(persisted));
  const accept = vi.fn<ConstructorParameters<typeof DeliverPersistedLeadRequest>[0]['accept']>(() =>
    Promise.resolve('TEST exact-report instruction')
  );
  const send = vi.fn(() => Promise.resolve());
  const readDelivered = vi.fn<
    ConstructorParameters<typeof DeliverPersistedLeadRequest>[0]['readDelivered']
  >(() => Promise.resolve(null));
  const assertCurrent = vi.fn<(run: typeof persisted.run) => void>(() => undefined);
  const claim = vi.fn<
    ConstructorParameters<typeof DeliverPersistedLeadRequest>[0]['input']['claim']
  >(() => Promise.resolve({ state: 'claimed', operationId: 'TEST-input-operation' }));
  const sent = vi.fn<ConstructorParameters<typeof DeliverPersistedLeadRequest>[0]['input']['sent']>(
    () => Promise.resolve()
  );
  const reserve = vi.fn<
    ConstructorParameters<typeof DeliverPersistedLeadRequest>[0]['input']['reserve']
  >(() => Promise.resolve());
  const requests = new DeliverPersistedLeadRequest({
    read,
    readDelivered,
    input: { reserve, claim, sent },
    accept,
    send,
    assertCurrent,
  });
  return { read, readDelivered, reserve, claim, sent, accept, send, assertCurrent, requests };
}

describe('persisted human request admission and exact durable reply closure', () => {
  it('registers before report admission so immediate app-owned delivery never reaches stdin', async () => {
    const { requests, accept, read, send } = setup();
    accept.mockImplementationOnce((input) => {
      requests.confirmDelivered(input.run, input.requestMessageId, 'TEST-delivered');
      return Promise.resolve('Already delivered; do not answer again');
    });
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toEqual({
      requestMessageId: persisted.requestMessageId,
      state: 'delivered',
    });
    expect(read).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await requests.execute(run, persisted.requestMessageId);
    expect(accept).toHaveBeenCalledOnce();
  });

  it('shares concurrent retries, sends the saved text and exact app ID once, and does not mistake stdin completion for a reply', async () => {
    const { requests, read, accept, send } = setup();
    const loaded = deferred<typeof persisted>();
    read.mockReturnValueOnce(loaded.promise);
    const first = requests.execute(run, persisted.requestMessageId);
    const second = requests.execute(run, persisted.requestMessageId);
    loaded.resolve(persisted);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual({ requestMessageId: persisted.requestMessageId, state: 'sent' });
    expect(results[1]).toEqual(results[0]);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(run, expect.stringContaining(persisted.text));
    expect(send).toHaveBeenCalledWith(run, expect.stringContaining(persisted.requestMessageId));
    expect(send).toHaveBeenCalledWith(
      run,
      expect.stringContaining('TEST exact-report instruction')
    );
    await requests.execute(run, persisted.requestMessageId);
    expect(send).toHaveBeenCalledOnce();
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({
      requestMessageId: 'TEST-human-2',
      state: 'queued',
    });
    expect(accept).toHaveBeenCalledOnce();
  });

  it('sends the next queued request only after the active request is durably delivered', async () => {
    const { requests, send, read, readDelivered } = setup();
    await requests.execute(run, 'TEST-human-1');
    expect(send).toHaveBeenCalledOnce();
    read.mockResolvedValue({ ...persisted, requestMessageId: 'TEST-human-2', text: 'second' });
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'queued' });
    expect(send).toHaveBeenCalledOnce();
    readDelivered.mockImplementation((_run, id) =>
      Promise.resolve(id === 'TEST-human-1' ? 'TEST-reply-1' : null)
    );
    requests.confirmDelivered(run, 'TEST-human-1', 'TEST-reply-1');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith(run, expect.stringContaining('second'));
  });

  it('only closes the named run and original request after durable publication', async () => {
    const { requests, read } = setup();
    await requests.execute(run, persisted.requestMessageId);
    expect(() =>
      requests.confirmDelivered(
        { ...run, runId: 'TEST-other' },
        persisted.requestMessageId,
        'TEST-reply'
      )
    ).toThrow('matching');
    expect(() => requests.confirmDelivered(run, 'TEST-unrelated', 'TEST-reply')).toThrow(
      'matching'
    );
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'queued' });
    requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-reply');
    requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-reply');
    expect(() =>
      requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-different-reply')
    ).toThrow('identity');
    read.mockResolvedValueOnce({ ...persisted, requestMessageId: 'TEST-human-2' });
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'sent' });
  });

  it('returns a completed request receipt without replacing a newer active human turn', async () => {
    const { requests, read, send } = setup();
    await requests.execute(run, persisted.requestMessageId);
    requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-first-reply');
    read.mockResolvedValueOnce({ ...persisted, requestMessageId: 'TEST-human-2' });
    await requests.execute(run, 'TEST-human-2');
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
    await expect(requests.execute(run, 'TEST-human-3')).resolves.toMatchObject({ state: 'queued' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('waits for the original send to settle even if durable delivery arrives during its write', async () => {
    const { requests, send, read } = setup();
    const written = deferred<void>();
    send.mockImplementationOnce(() => {
      requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-reply');
      return written.promise;
    });
    const first = requests.execute(run, persisted.requestMessageId);
    await expect.poll(() => send.mock.calls.length).toBe(1);
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'queued' });
    written.resolve();
    await expect(first).resolves.toMatchObject({ state: 'delivered' });
    read.mockResolvedValueOnce({ ...persisted, requestMessageId: 'TEST-human-2' });
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'sent' });
  });

  it('does not report acceptance to a stale connection after its pending stdin write finishes', async () => {
    const { requests, send, assertCurrent } = setup();
    const written = deferred<void>();
    send.mockReturnValueOnce(written.promise);
    const result = requests.execute(run, persisted.requestMessageId);
    await expect.poll(() => send.mock.calls.length).toBe(1);
    assertCurrent.mockImplementation(() => {
      throw new Error('TEST context invalidated during send');
    });
    written.resolve();
    await expect(result).rejects.toThrow('invalidated during send');
    expect(send).toHaveBeenCalledOnce();
  });

  it('durably reserves the original turn before reporting can publish or another composition can admit a successor', async () => {
    const { requests, reserve, accept, send } = setup();
    reserve.mockRejectedValueOnce(new Error('TEST previous durable human turn still active'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'durable human turn'
    );
    expect(accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('persists input intent before writing and records sent only after that write completes', async () => {
    const { requests, claim, sent, send } = setup();
    const claimed = deferred<Awaited<ReturnType<typeof claim>>>();
    claim.mockReturnValueOnce(claimed.promise);
    const result = requests.execute(run, persisted.requestMessageId);
    await expect.poll(() => claim.mock.calls.length).toBe(1);
    expect(send).not.toHaveBeenCalled();
    claimed.resolve({ state: 'claimed', operationId: 'TEST-exact-operation' });
    await result;
    expect(sent).toHaveBeenCalledWith(persisted, 'TEST-exact-operation');
    expect(sent.mock.invocationCallOrder[0]).toBeGreaterThan(send.mock.invocationCallOrder[0]);
  });

  it.each(['sent', 'unconfirmed'] as const)(
    'never writes again when durable input intent is already %s',
    async (state) => {
      const { requests, claim, sent, send } = setup();
      claim.mockResolvedValueOnce({ state });
      if (state === 'sent')
        await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
          state: 'sent',
        });
      else
        await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
          'unconfirmed'
        );
      expect(send).not.toHaveBeenCalled();
      expect(sent).not.toHaveBeenCalled();
    }
  );

  it('does not write without a persisted input claim and cannot resend after confirmation persistence fails', async () => {
    const { requests, claim, sent, send } = setup();
    claim.mockRejectedValueOnce(new Error('TEST intent persistence unavailable'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'intent persistence'
    );
    expect(send).not.toHaveBeenCalled();
    sent.mockRejectedValueOnce(new Error('TEST sent confirmation failed'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow('unconfirmed');
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow('unconfirmed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not write a duplicate turn when exact delivery arrives while input intent is being persisted', async () => {
    const { requests, claim, send } = setup();
    claim.mockImplementationOnce(() => {
      requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-durable-reply');
      return Promise.resolve({ state: 'claimed', operationId: 'TEST-claimed' });
    });
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send after context invalidation while the durable input claim is pending', async () => {
    const { requests, claim, assertCurrent, send } = setup();
    claim.mockImplementationOnce(() => {
      assertCurrent.mockImplementation(() => {
        throw new Error('TEST invalidated during input claim');
      });
      return Promise.resolve({ state: 'claimed', operationId: 'TEST-claimed' });
    });
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'invalidated during input claim'
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('does not resend an uncertain stdin write or admit a successor before its exact reply', async () => {
    const { requests, send } = setup();
    send.mockRejectedValueOnce(new Error('TEST pipe failed after possible acceptance'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow('unconfirmed');
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow('unconfirmed');
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'queued' });
    expect(send).toHaveBeenCalledOnce();
    requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-durable-reply');
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
  });

  it('does not let an absent persisted record reserve the team against a valid human request', async () => {
    const { requests, read } = setup();
    read.mockRejectedValueOnce(new Error('TEST saved record unavailable'));
    await expect(requests.execute(run, 'TEST-missing')).rejects.toThrow('unavailable');
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'sent',
    });
  });

  it('rechecks ownership after reading persistence before reporting can admit a turn', async () => {
    const { requests, assertCurrent, read, accept, send } = setup();
    read.mockImplementationOnce(() => {
      assertCurrent.mockImplementation(() => {
        throw new Error('TEST stopped during read');
      });
      return Promise.resolve(persisted);
    });
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'stopped during read'
    );
    expect(accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('detaches persisted input before reporting can mutate its backing record', async () => {
    const { requests, read, accept, send } = setup();
    const saved = { ...persisted, run: { ...run }, origin: { kind: 'human' as const } };
    read.mockResolvedValueOnce(saved);
    accept.mockImplementationOnce((input) => {
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.run)).toBe(true);
      expect(Object.isFrozen(input.origin)).toBe(true);
      saved.text = 'TEST changed after read';
      saved.run.runId = 'TEST-other';
      return Promise.resolve('TEST instruction');
    });
    await requests.execute(run, persisted.requestMessageId);
    expect(send).toHaveBeenCalledWith(run, expect.stringContaining(persisted.text));
    expect(send).not.toHaveBeenCalledWith(run, expect.stringContaining(saved.text));
  });

  it('does not discard a confirmed reply when the in-flight pipe later reports failure', async () => {
    const { requests, send } = setup();
    send.mockImplementationOnce(() => {
      requests.confirmDelivered(run, persisted.requestMessageId, 'TEST-reply');
      return Promise.reject(new Error('TEST late pipe failure'));
    });
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
    await requests.execute(run, persisted.requestMessageId);
    expect(send).toHaveBeenCalledOnce();
  });

  it('can retry admission failure for the same saved request but never replaces it with a different one', async () => {
    const { requests, accept, send } = setup();
    accept.mockRejectedValueOnce(new Error('TEST source unavailable before instruction'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'source unavailable'
    );
    await expect(requests.execute(run, 'TEST-human-2')).resolves.toMatchObject({ state: 'queued' });
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'sent',
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { requestMessageId: 'TEST-other' },
    { run: { ...run, runId: 'TEST-old' } },
    { origin: { kind: 'service' } },
    { isMeta: true },
    { text: '' },
  ])(
    'rejects a foreign or service-origin persisted record before admission: %j',
    async (fields) => {
      const { requests, read, accept, send } = setup();
      read.mockResolvedValueOnce({ ...persisted, ...fields } as typeof persisted);
      await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow();
      expect(accept).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('accepts the complete app-owned reply identity when a valid request uses its maximum ID length', async () => {
    const { requests, read } = setup();
    const id = 'x'.repeat(256);
    read.mockResolvedValueOnce({ ...persisted, requestMessageId: id });
    await requests.execute(run, id);
    requests.confirmDelivered(run, id, `lead-reply:${run.runId}:${id}`);
    await expect(requests.execute(run, id)).resolves.toMatchObject({ state: 'delivered' });
  });

  it('restores an exact persisted reply before reporting can admit or resend a completed turn', async () => {
    const { requests, readDelivered, accept, send } = setup();
    readDelivered.mockResolvedValueOnce('TEST-durable-reply');
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
    expect(accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('retries reporting notification after admission failed following a durable append, rather than bypassing its closure', async () => {
    const { requests, readDelivered, accept, send } = setup();
    accept.mockRejectedValueOnce(new Error('TEST notification failed after append'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'notification failed'
    );
    readDelivered.mockResolvedValueOnce('TEST-durable-reply');
    accept.mockImplementationOnce((input) => {
      requests.confirmDelivered(input.run, input.requestMessageId, 'TEST-durable-reply');
      return Promise.resolve('Already delivered');
    });
    await expect(requests.execute(run, persisted.requestMessageId)).resolves.toMatchObject({
      state: 'delivered',
    });
    expect(accept).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('continues after 200 completed turns and cannot reopen an evicted completed request', async () => {
    const { requests, read, readDelivered, send } = setup();
    for (let index = 0; index < 205; index++) {
      const id = `TEST-human-${index}`;
      read.mockResolvedValueOnce({ ...persisted, requestMessageId: id });
      await requests.execute(run, id);
      requests.confirmDelivered(run, id, `TEST-reply-${index}`);
    }
    read.mockResolvedValueOnce({ ...persisted, requestMessageId: 'TEST-human-0' });
    readDelivered.mockResolvedValueOnce('TEST-reply-0');
    await expect(requests.execute(run, 'TEST-human-0')).resolves.toMatchObject({
      state: 'delivered',
    });
    expect(send).toHaveBeenCalledTimes(205);
  });

  it('does not guess delivery when persisted reply evidence cannot be read', async () => {
    const { requests, readDelivered, accept, send } = setup();
    readDelivered.mockRejectedValueOnce(new Error('TEST reply history unavailable'));
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow(
      'reply history unavailable'
    );
    expect(accept).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks the context after asynchronous report preparation and does not send to a stopped successor', async () => {
    const { requests, assertCurrent, accept, send } = setup();
    accept.mockImplementationOnce(() => {
      assertCurrent.mockImplementation(() => {
        throw new Error('TEST run invalidated');
      });
      return Promise.resolve('TEST instruction');
    });
    await expect(requests.execute(run, persisted.requestMessageId)).rejects.toThrow('invalidated');
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['', ' TEST-human-1', 'TEST\nforged', 'x'.repeat(257)])(
    'rejects an invalid app-issued message ID: %j',
    async (id) => {
      const { requests, read } = setup();
      await expect(requests.execute(run, id)).rejects.toThrow('identity');
      expect(read).not.toHaveBeenCalled();
    }
  );
});
