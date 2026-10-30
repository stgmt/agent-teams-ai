// @vitest-environment node
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeLeadInputDeliveryStore } from '../../../../src/features/team-provisioning/main/adapters/output/NodeLeadInputDeliveryStore';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-lead-input-intent-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  const run = {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: root,
    connectionGeneration: 1,
    teamName: 'test-team',
    runId: 'TEST-run',
  };
  const request = {
    run,
    requestMessageId: 'TEST-human',
    text: 'The original persisted question',
    origin: { kind: 'human' as const },
    isMeta: false as const,
  };
  const teamDirectory = join(teamsRoot, run.teamName);
  await mkdir(teamDirectory, { recursive: true });
  const readDelivered = vi.fn<
    ConstructorParameters<typeof NodeLeadInputDeliveryStore>[0]['readDelivered']
  >(() => Promise.resolve(null));
  const create = () =>
    new NodeLeadInputDeliveryStore({ teamsRoot, assertCurrent: () => undefined, readDelivered });
  return { root, teamsRoot, teamDirectory, request, create, readDelivered };
}

// РИСК: real temporary intent files and locks; not a native CLI stdin or a power-loss test.
describe('durable exact human input intent', () => {
  it('publishes one claim before input and retains unconfirmed intent across a new store instance', async () => {
    const { request, create } = await setup();
    const first = await create().claim(request);
    expect(first.state).toBe('claimed');
    await expect(create().claim(request)).resolves.toEqual({ state: 'unconfirmed' });
    if (first.state !== 'claimed') throw new Error('TEST missing claim');
    await create().sent(request, first.operationId);
    await expect(create().claim(request)).resolves.toEqual({ state: 'sent' });
  });

  it('admits only one concurrent claim across independently composed adapters', async () => {
    const { request, create } = await setup();
    const results = await Promise.all([create().claim(request), create().claim(request)]);
    expect(results.filter((result) => result.state === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.state === 'unconfirmed')).toHaveLength(1);
  });

  it('keeps an admitted human turn reserved across adapters before any stdin attempt and admits the next only after its exact persisted reply', async () => {
    const { request, create, readDelivered } = await setup();
    await create().reserve(request);
    await create().reserve(request);
    await expect(create().reserve({ ...request, text: 'Changed original' })).rejects.toThrow(
      'differs'
    );
    const next = { ...request, requestMessageId: 'TEST-next' };
    await expect(create().reserve(next)).rejects.toThrow('durable human request is still active');
    expect(readDelivered).toHaveBeenCalledWith(request.run, request.requestMessageId);
    readDelivered.mockImplementation((_run, id) =>
      Promise.resolve(id === request.requestMessageId ? 'TEST-exact-reply' : null)
    );
    await create().reserve(next);
    await expect(create().claim(next)).resolves.toMatchObject({ state: 'claimed' });
    await expect(create().claim(request)).rejects.toThrow('durable human request is still active');
  });

  it('serializes distinct reservations rather than allowing both original turns into reporting', async () => {
    const { request, create } = await setup();
    const results = await Promise.allSettled([
      create().reserve(request),
      create().reserve({ ...request, requestMessageId: 'TEST-other' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('keeps a reserved turn retryable before input and never lets sent confirmation skip the input claim', async () => {
    const { request, create, teamDirectory } = await setup();
    await create().reserve(request);
    const directory = join(teamDirectory, 'lead-input-delivery');
    const row = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), 'utf8'));
    await expect(create().sent(request, row.operationId as string)).rejects.toThrow('operation');
    await expect(create().claim(request)).resolves.toMatchObject({ state: 'claimed' });
  });

  it('rejects an intent copied under another hashed identity instead of treating the original turn as absent', async () => {
    const { request, create, teamDirectory } = await setup();
    await create().reserve(request);
    const directory = join(teamDirectory, 'lead-input-delivery');
    const path = join(directory, (await readdir(directory))[0]);
    const { rename } = await import('node:fs/promises');
    await rename(path, join(directory, `${'0'.repeat(64)}.json`));
    await expect(create().reserve(request)).rejects.toThrow('identity');
  });

  it('does not replace durable reservation when reply history cannot be read', async () => {
    const { request, create, readDelivered } = await setup();
    await create().reserve(request);
    readDelivered.mockRejectedValueOnce(new Error('TEST reply history unavailable'));
    await expect(create().reserve({ ...request, requestMessageId: 'TEST-next' })).rejects.toThrow(
      'reply history unavailable'
    );
    await expect(create().claim(request)).resolves.toMatchObject({ state: 'claimed' });
  });

  it('binds an intent to original text and the complete run, and never confirms a foreign operation', async () => {
    const { request, create } = await setup();
    const store = create();
    const first = await store.claim(request);
    if (first.state !== 'claimed') throw new Error('TEST missing claim');
    await expect(store.claim({ ...request, text: 'Changed' })).rejects.toThrow('differs');
    await expect(store.sent(request, 'TEST-foreign-operation')).rejects.toThrow('operation');
    await expect(
      store.claim({ ...request, run: { ...request.run, connectionGeneration: 2 } })
    ).resolves.toMatchObject({ state: 'claimed' });
    await store.sent(request, first.operationId);
    await store.sent(request, first.operationId);
  });

  it('does not rewrite the selected history or retain human text inside delivery metadata', async () => {
    const { request, create, teamDirectory } = await setup();
    const history = join(teamDirectory, 'sentMessages.json');
    await writeFile(history, 'TEST original canonical history');
    await create().claim(request);
    expect(await readFile(history, 'utf8')).toBe('TEST original canonical history');
    const directory = join(teamDirectory, 'lead-input-delivery');
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const stored = await readFile(join(directory, files[0]), 'utf8');
    expect(stored).not.toContain(request.text);
    expect(JSON.parse(stored)).toMatchObject({
      schemaVersion: 1,
      state: 'unconfirmed',
      requestMessageId: request.requestMessageId,
    });
  });

  it.each(['broken JSON', JSON.stringify({ schemaVersion: 1 }), ' '.repeat(32_769)])(
    'never discards malformed existing intent: %s',
    async (content) => {
      const { request, create, teamDirectory } = await setup();
      await create().claim(request);
      const directory = join(teamDirectory, 'lead-input-delivery');
      const path = join(directory, (await readdir(directory))[0]);
      await writeFile(path, content);
      await expect(create().claim(request)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  );

  it('rejects a redirected intent directory or a hard-linked intent file', async () => {
    const { request, create, teamDirectory, root } = await setup();
    await create().claim(request);
    const directory = join(teamDirectory, 'lead-input-delivery');
    const path = join(directory, (await readdir(directory))[0]);
    await link(path, join(root, 'TEST-hardlink.json'));
    await expect(create().claim(request)).rejects.toThrow('regular private file');
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    const foreign = join(root, 'TEST-foreign');
    await mkdir(foreign);
    await symlink(foreign, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(create().claim(request)).rejects.toThrow('redirected');
    expect(await readdir(foreign)).toEqual([]);
  });

  it('rejects a replacement with matching metadata between lstat and open instead of accepting another file identity', async () => {
    const { request, create, teamDirectory, root } = await setup();
    await create().claim(request);
    const directory = join(teamDirectory, 'lead-input-delivery');
    const path = join(directory, (await readdir(directory))[0]);
    const replacement = join(root, 'TEST-replacement.json');
    await writeFile(replacement, await readFile(path));
    const original = await import('node:fs');
    const open = original.promises.open.bind(original.promises);
    const spy = vi.spyOn(original.promises, 'open').mockImplementationOnce(async (...args) => {
      await original.promises.rename(replacement, path);
      return open(...args);
    });
    try {
      await expect(create().claim(request)).rejects.toThrow('regular private file');
    } finally {
      spy.mockRestore();
    }
    await expect(create().claim(request)).resolves.toMatchObject({ state: 'unconfirmed' });
  });

  it('rechecks ownership at atomic commit and leaves no claimed input when the run was invalidated', async () => {
    const { request, teamsRoot, teamDirectory } = await setup();
    const original = await import('node:fs');
    const open = original.promises.open.bind(original.promises);
    let current = true;
    const store = new NodeLeadInputDeliveryStore({
      teamsRoot,
      readDelivered: () => Promise.resolve(null),
      assertCurrent: () => {
        if (!current) throw new Error('TEST invalidated before commit');
      },
    });
    const spy = vi.spyOn(original.promises, 'open').mockImplementationOnce(async (...args) => {
      current = false;
      return open(...args);
    });
    try {
      await expect(store.claim(request)).rejects.toThrow('invalidated before commit');
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(join(teamDirectory, 'lead-input-delivery'))).toEqual([]);
    current = true;
    await expect(store.claim(request)).resolves.toMatchObject({ state: 'claimed' });
  });

  it('rejects stale ownership before any intent file can be committed', async () => {
    const { request, teamsRoot, teamDirectory } = await setup();
    const store = new NodeLeadInputDeliveryStore({
      teamsRoot,
      readDelivered: () => Promise.resolve(null),
      assertCurrent: () => {
        throw new Error('TEST stale run');
      },
    });
    await expect(store.claim(request)).rejects.toThrow('stale');
    await expect(readFile(join(teamDirectory, 'lead-input-delivery'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
