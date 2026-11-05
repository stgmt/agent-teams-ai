import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileVerifiedActionStore } from '../infrastructure/FileVerifiedActionStore';

import { VerifiedActionService } from './VerifiedActionService';

import type { VerifiedActionProof } from '../../contracts';

const proof: VerifiedActionProof = { attachmentId: 'report', sha256: 'a'.repeat(64), size: 23 };
const scratchRoots: string[] = [];
const requireFromTest = createRequire(import.meta.url);

afterEach(async () => {
  const scratchParent = await fs.promises.realpath(os.tmpdir());
  for (const root of scratchRoots.splice(0)) {
    const resolved = await fs.promises.realpath(root);
    const relative = path.relative(scratchParent, resolved);
    if (!relative.startsWith('verified-action-test-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a test fixture outside its scratch parent');
    }
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'verified-action-test-'));
  scratchRoots.push(root);
  const store = new FileVerifiedActionStore(root);
  const verify = vi.fn(async () => ({ ...proof }));
  const enqueue = vi.fn((action) => store.enqueue(action));
  const service = new VerifiedActionService({ store, verify, enqueue });
  return { root, store, verify, enqueue, service };
}

describe('verified artifact action', () => {
  it('uses the real controller proof again immediately before adding a manifest', async () => {
    const { root, store } = await fixture();
    const project = path.join(root, 'project');
    const teamDir = path.join(root, 'teams', 'fixture');
    await fs.promises.mkdir(project);
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        projectPath: project,
        members: [{ name: 'worker', role: 'developer' }],
      })
    );
    const controller = requireFromTest(
      path.resolve('agent-teams-controller/src/index.js')
    ) as typeof import('agent-teams-controller');
    const board = controller.createController({ teamName: 'fixture', claudeDir: root }).taskBoard;
    const task = board.createTask({ subject: 'result', owner: 'worker' }) as { id: string };
    board.updateTaskFields(task.id, {
      artifactRequired: true,
      artifactFile: {
        filename: 'result.txt',
        base64Data: Buffer.from('verified').toString('base64'),
      },
    });
    const proof = board.verifyTaskArtifact(task.id)!;
    const snapshot = board.getTask(task.id) as { attachments: { id: string; filePath: string }[] };
    const file = snapshot.attachments.find((item) => item.id === proof.attachmentId)!.filePath;
    const service = new VerifiedActionService({
      store,
      verify: async () => board.verifyTaskArtifact(task.id),
      enqueue: (action) => store.enqueue(action),
    });
    const prepared = await service.prepare('scope', 'fixture', task.id);
    await fs.promises.writeFile(file, 'changed!');
    await expect(service.approve('scope', prepared.id)).rejects.toThrow(/changed/);
    await expect(
      fs.promises.stat(path.join(root, 'queue', `${prepared.id}.json`))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.promises.writeFile(file, 'verified');
    expect(await service.approve('scope', prepared.id)).toMatchObject({
      status: 'completed',
      completion: 'queued',
    });
  });
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

  it('does not enqueue when the proof changes while the running state is being persisted', async () => {
    const { store, verify } = await fixture();
    const hookedStore = {
      transaction: <T>(fn: Parameters<typeof store.transaction<T>>[0]) =>
        store.transaction((tx) =>
          fn({
            ...tx,
            write: async (actions) => {
              await tx.write(actions);
              if (actions.some((action) => action.status === 'running')) {
                verify.mockResolvedValue({ ...proof, sha256: 'b'.repeat(64) });
              }
            },
          })
        ),
    };
    const enqueue = vi.fn();
    const service = new VerifiedActionService({ store: hookedStore, verify, enqueue });
    const action = await service.prepare('scope', 'team', 'task');
    expect(await service.approve('scope', action.id)).toMatchObject({
      status: 'manual',
      attempts: 1,
    });
    expect(enqueue).not.toHaveBeenCalled();
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
