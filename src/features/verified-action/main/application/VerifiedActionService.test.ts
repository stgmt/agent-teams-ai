import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { FileVerifiedActionStore } from '../infrastructure/FileVerifiedActionStore';

import { VerifiedActionService } from './VerifiedActionService';

import type { VerifiedActionProof } from '../../contracts';

const proof: VerifiedActionProof = { attachmentId: 'report', sha256: 'a'.repeat(64), size: 23 };

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-action-test-'));
  const store = new FileVerifiedActionStore(root);
  const verify = vi.fn(async () => ({ ...proof }));
  const enqueue = vi.fn((action) => store.enqueue(action));
  const service = new VerifiedActionService({ store, verify, enqueue });
  return { root, store, verify, enqueue, service };
}

describe('verified artifact action', () => {
  it('requires explicit approval and writes one manifest even for concurrent duplicate approvals', async () => {
    const { root, service, enqueue } = await fixture();
    const [first, duplicate] = await Promise.all([
      service.prepare('scope', 'team', 'task'),
      service.prepare('scope', 'team', 'task'),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(enqueue).not.toHaveBeenCalled();
    const results = await Promise.all([
      service.approve('scope', first.id),
      service.approve('scope', first.id),
    ]);
    expect(results.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(
      await fs.promises.readFile(path.join(root, 'queue', `${first.id}.json`), 'utf8')
    );
    expect(manifest).toMatchObject({ id: first.id, teamName: 'team', taskId: 'task', proof });
    expect((await service.prepare('scope', 'team', 'task')).status).toBe('completed');
  });

  it('persists one question after a lost response and allows only one explicitly approved retry', async () => {
    const { store, verify, service } = await fixture();
    const enqueue = vi.fn(async (action) => {
      await store.enqueue(action);
      throw new Error('response lost');
    });
    const uncertain = new VerifiedActionService({ store, verify, enqueue });
    const action = await service.prepare('scope', 'team', 'task');
    expect((await uncertain.approve('scope', action.id)).status).toBe('question');
    const restarted = new VerifiedActionService({ store, verify, enqueue });
    expect((await restarted.list('scope', 'team', 'task'))[0].status).toBe('question');
    expect((await restarted.list('scope', 'team', 'task'))[0].status).toBe('question');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const result = await restarted.decide('scope', action.id, 'retry_once');
    expect(result).toMatchObject({ status: 'manual', attempts: 2 });
    await expect(restarted.decide('scope', action.id, 'retry_once')).rejects.toThrow(
      'no pending question'
    );
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect((await restarted.list('scope', 'team', 'task'))[0].status).toBe('manual');
  });

  it('recovers a crashed in-flight attempt without executing it', async () => {
    const { store, service, enqueue } = await fixture();
    const action = await service.prepare('scope', 'team', 'task');
    await store.transaction(async (tx) => {
      const items = await tx.read();
      Object.assign(items[0], { status: 'running', attempts: 1 });
      await tx.write(items);
    });
    expect((await service.list('scope', 'team', 'task'))[0]).toMatchObject({
      id: action.id,
      status: 'question',
    });
    expect(enqueue).not.toHaveBeenCalled();
    const resolved = await service.decide('scope', action.id, 'completed');
    expect(resolved).toMatchObject({ status: 'completed', completion: 'user_attested' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never enqueues a changed or missing proof and records an unresolved decision', async () => {
    const { store, verify, service, enqueue } = await fixture();
    const action = await service.prepare('scope', 'team', 'task');
    verify.mockResolvedValueOnce({ ...proof, sha256: 'b'.repeat(64) });
    await expect(service.approve('scope', action.id)).rejects.toThrow('artifact changed');
    expect(enqueue).not.toHaveBeenCalled();
    const lost = new VerifiedActionService({
      store,
      verify,
      enqueue: async () => {
        throw new Error('unknown');
      },
    });
    expect((await lost.approve('scope', action.id)).status).toBe('question');
    expect((await lost.decide('scope', action.id, 'leave_unresolved')).status).toBe('manual');
    await expect(lost.decide('scope', action.id, 'retry_once')).rejects.toThrow(
      'no pending question'
    );
  });

  it('consumes the only retry decision without executing when the artifact changed', async () => {
    const { store, verify, service } = await fixture();
    const enqueue = vi.fn(async () => {
      throw new Error('outcome lost');
    });
    const uncertain = new VerifiedActionService({ store, verify, enqueue });
    const action = await service.prepare('scope', 'team', 'task');
    expect((await uncertain.approve('scope', action.id)).status).toBe('question');
    verify.mockResolvedValueOnce({ ...proof, sha256: 'b'.repeat(64) });
    expect(await uncertain.decide('scope', action.id, 'retry_once')).toMatchObject({
      status: 'manual',
      attempts: 1,
    });
    await expect(uncertain.decide('scope', action.id, 'retry_once')).rejects.toThrow(
      'no pending question'
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
