// @vitest-environment node
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeLeadRequestHistory } from '../../../../src/features/team-provisioning/main/adapters/output/NodeLeadRequestHistory';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-persisted-lead-request-'));
  directories.push(root);
  const teamsRoot = join(root, 'selected', 'teams');
  const run = {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: 'TEST-root',
    connectionGeneration: 1,
    teamName: 'test-team',
    runId: 'TEST-run',
  };
  const teamDirectory = join(teamsRoot, run.teamName);
  await mkdir(teamDirectory, { recursive: true });
  const path = join(teamDirectory, 'sentMessages.json');
  const row = {
    from: 'user',
    to: 'team-lead',
    source: 'user_sent',
    read: true,
    messageId: 'TEST-human-1',
    leadSessionId: run.runId,
    text: 'The original saved human question',
    timestamp: '2026-10-29T02:30:00.000Z',
  };
  await writeFile(path, JSON.stringify([row]));
  const leadName = vi.fn(() => 'team-lead');
  const assertCurrent = vi.fn(() => undefined);
  const reader = new NodeLeadRequestHistory({ teamsRoot, leadName, assertCurrent });
  return { root, teamsRoot, teamDirectory, run, path, row, leadName, assertCurrent, reader };
}

// РИСК: real temporary canonical history files, not a production queue or a native model session.
describe('canonical persisted human request reader', () => {
  it('reads the exact saved human request in the selected profile without writing or scanning other inboxes', async () => {
    const { reader, path, run, row, teamsRoot } = await setup();
    const otherTeam = join(teamsRoot, 'other-team');
    await mkdir(join(otherTeam, 'inboxes'), { recursive: true });
    await writeFile(
      join(otherTeam, 'sentMessages.json'),
      JSON.stringify([{ ...row, text: 'Foreign' }])
    );
    const before = await readFile(path, 'utf8');
    const result = await reader.read(run, row.messageId);
    expect(result).toEqual({
      run,
      requestMessageId: row.messageId,
      text: row.text,
      origin: { kind: 'human' },
      isMeta: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.run)).toBe(true);
    expect(Object.isFrozen(result?.origin)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('never uses another profile or an inbox copy when selected canonical sent history is absent', async () => {
    const { root, reader, run, row, path, teamDirectory } = await setup();
    const other = join(root, 'other', 'teams', run.teamName);
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'sentMessages.json'), JSON.stringify([row]));
    await mkdir(join(teamDirectory, 'inboxes'));
    await writeFile(join(teamDirectory, 'inboxes', 'team-lead.json'), JSON.stringify([row]));
    await rm(path);
    await expect(reader.read(run, row.messageId)).resolves.toBeNull();
  });

  it.each([
    { from: 'team-lead' },
    { to: 'builder' },
    { source: 'runtime_delivery' },
    { source: 'system_notification' },
    { source: undefined },
    { leadSessionId: 'TEST-old-run' },
    { leadSessionId: undefined },
    { messageKind: 'slash_command' },
    { isMeta: true },
    { origin: { kind: 'service' } },
    { relayOfMessageId: 'TEST-original' },
    { groupChatId: 'TEST-group' },
    { attachments: [{ id: 'TEST-file', name: 'test.txt' }] },
    { fileReferences: [{ name: 'test.txt' }] },
    { text: '' },
    { text: 'x'.repeat(64_001) },
  ])('does not admit a non-original or differently bound record: %j', async (fields) => {
    const { reader, run, row, path } = await setup();
    await writeFile(path, JSON.stringify([{ ...row, ...fields }]));
    await expect(reader.read(run, row.messageId)).rejects.toThrow();
  });

  it('rejects an ambiguous duplicate identity instead of choosing a matching copy', async () => {
    const { reader, run, row, path } = await setup();
    await writeFile(path, JSON.stringify([row, { ...row, text: 'Different original' }]));
    await expect(reader.read(run, row.messageId)).rejects.toThrow('ambiguous');
  });

  it.each(['broken JSON', JSON.stringify({ messageId: 'TEST-human-1' })])(
    'reports malformed canonical history instead of treating it as an empty history: %s',
    async (text) => {
      const { reader, run, row, path } = await setup();
      await writeFile(path, text);
      await expect(reader.read(run, row.messageId)).rejects.toThrow();
    }
  );

  it('rejects a directory or a hard-linked history file before parsing', async () => {
    const { reader, run, row, path, root } = await setup();
    await link(path, join(root, 'shared-history.json'));
    await expect(reader.read(run, row.messageId)).rejects.toThrow('regular private file');
    await rm(path);
    await mkdir(path);
    await expect(reader.read(run, row.messageId)).rejects.toThrow('regular private file');
  });

  it('rejects a redirected team directory without reading the other profile', async () => {
    const { root, teamDirectory, reader, run, row } = await setup();
    const redirected = join(root, 'redirected');
    await mkdir(redirected);
    await writeFile(join(redirected, 'sentMessages.json'), JSON.stringify([row]));
    await rm(teamDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await symlink(redirected, teamDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(reader.read(run, row.messageId)).rejects.toThrow('redirected');
  });

  it.each(['../test-team', ' test-team', 'TEST-team'])(
    'rejects a non-exact team name before resolving a lead: %s',
    async (teamName) => {
      const { reader, run, row, leadName } = await setup();
      await expect(reader.read({ ...run, teamName }, row.messageId)).rejects.toThrow();
      expect(leadName).not.toHaveBeenCalled();
    }
  );

  it('rejects oversized canonical history before accepting an otherwise valid request', async () => {
    const { reader, run, row, path } = await setup();
    await writeFile(path, `${JSON.stringify([row])}${' '.repeat(2 * 1024 * 1024)}`);
    await expect(reader.read(run, row.messageId)).rejects.toThrow('size limit');
  });

  it('retries after an atomic writer replaces the file between lstat and open', async () => {
    const { reader, run, row, path, root } = await setup();
    const original = await import('node:fs');
    const open = original.promises.open.bind(original.promises);
    const replacement = join(root, 'TEST-new-history.json');
    await writeFile(replacement, JSON.stringify([row]));
    const spy = vi.spyOn(original.promises, 'open').mockImplementationOnce(async (...args) => {
      await original.promises.rename(replacement, path);
      return open(...args);
    });
    try {
      await expect(reader.read(run, row.messageId)).rejects.toThrow('regular private file');
    } finally {
      spy.mockRestore();
    }
    await expect(reader.read(run, row.messageId)).resolves.toMatchObject({ text: row.text });
  });

  it('reads exact app-owned durable reply evidence and rejects an ambiguous completion', async () => {
    const { reader, run, row, teamDirectory } = await setup();
    const inbox = join(teamDirectory, 'inboxes', 'user.json');
    const reply = {
      from: 'team-lead',
      to: 'user',
      source: 'lead_process',
      leadSessionId: run.runId,
      messageId: `lead-reply:${run.runId}:${row.messageId}`,
      text: 'The saved answer',
      replyChannel: 'explicit',
      replyToMessageIds: [row.messageId],
    };
    await expect(reader.readDelivered(run, row.messageId)).resolves.toBeNull();
    await mkdir(join(teamDirectory, 'inboxes'));
    await writeFile(inbox, JSON.stringify([reply]));
    await expect(reader.readDelivered(run, row.messageId)).resolves.toBe(reply.messageId);
    await writeFile(
      inbox,
      JSON.stringify([reply, { ...reply, messageId: 'lead-report:TEST-other' }])
    );
    await expect(reader.readDelivered(run, row.messageId)).rejects.toThrow('ambiguous');
  });

  it.each([
    { from: 'builder' },
    { source: 'runtime_delivery' },
    { leadSessionId: 'TEST-old' },
    { replyChannel: 'acknowledgement' },
    { replyToMessageIds: ['TEST-other'] },
    { replyToMessageIds: ['TEST-human-1', 'TEST-other'] },
    { messageId: 'TEST-unowned-reply' },
    { to: 'builder' },
    { text: '' },
  ])('does not treat a non-exact inbox row as delivered: %j', async (fields) => {
    const { reader, run, row, teamDirectory } = await setup();
    await mkdir(join(teamDirectory, 'inboxes'));
    await writeFile(
      join(teamDirectory, 'inboxes', 'user.json'),
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'user',
          source: 'lead_process',
          leadSessionId: run.runId,
          messageId: `lead-reply:${run.runId}:${row.messageId}`,
          text: 'The saved answer',
          replyChannel: 'explicit',
          replyToMessageIds: [row.messageId],
          ...fields,
        },
      ])
    );
    await expect(reader.readDelivered(run, row.messageId)).resolves.toBeNull();
  });

  it('persists one canonical original human row before it can be read for admission, without duplicating an exact retry', async () => {
    const { reader, run, path, row } = await setup();
    await rm(path);
    const input = {
      run,
      requestMessageId: row.messageId,
      text: row.text,
      origin: { kind: 'human' as const },
      isMeta: false as const,
    };
    await reader.persist(input);
    await reader.persist(input);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      from: 'user',
      to: 'team-lead',
      source: 'user_sent',
      leadSessionId: run.runId,
      messageId: row.messageId,
      text: row.text,
    });
    await expect(reader.read(run, row.messageId)).resolves.toEqual(input);
    await expect(reader.persist({ ...input, text: 'Changed' })).rejects.toThrow('differs');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved);
  });

  it('serializes canonical appends without losing distinct saved questions', async () => {
    const { reader, run, path, row } = await setup();
    const input = {
      run,
      requestMessageId: 'TEST-new',
      text: 'First',
      origin: { kind: 'human' as const },
      isMeta: false as const,
    };
    await Promise.all([
      reader.persist(input),
      reader.persist({ ...input, requestMessageId: 'TEST-other', text: 'Second' }),
    ]);
    const rows = JSON.parse(await readFile(path, 'utf8'));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: row.messageId }),
        expect.objectContaining({ messageId: input.requestMessageId, text: 'First' }),
        expect.objectContaining({ messageId: 'TEST-other', text: 'Second' }),
      ])
    );
  });

  it('allows only one original when simultaneous submissions reuse an ID with different text', async () => {
    const { reader, run, path } = await setup();
    const input = {
      run,
      requestMessageId: 'TEST-collision',
      text: 'First original',
      origin: { kind: 'human' as const },
      isMeta: false as const,
    };
    const results = await Promise.allSettled([
      reader.persist(input),
      reader.persist({ ...input, text: 'Second original' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rows = JSON.parse(await readFile(path, 'utf8')) as { messageId: string; text: string }[];
    const matches = rows.filter((row) => row.messageId === input.requestMessageId);
    expect(matches).toHaveLength(1);
    expect(['First original', 'Second original']).toContain(matches[0].text);
  });

  it.each([
    { from: 'builder' },
    { source: 'runtime_delivery' },
    { leadSessionId: 'TEST-foreign-run' },
    { messageKind: 'slash_command' },
    { origin: { kind: 'service' } },
    { isMeta: true },
  ])(
    'does not turn a colliding non-original history row into a human request: %j',
    async (fields) => {
      const { reader, run, row, path } = await setup();
      const before = JSON.stringify([{ ...row, ...fields }]);
      await writeFile(path, before);
      await expect(
        reader.persist({
          run,
          requestMessageId: row.messageId,
          text: row.text,
          origin: { kind: 'human' as const },
          isMeta: false as const,
        })
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  );

  it('does not truncate previous history to make room for a new human request', async () => {
    const { reader, run, row, path } = await setup();
    const saved = JSON.stringify([{ ...row, text: 'x'.repeat(2 * 1024 * 1024 - 500) }]);
    await writeFile(path, saved);
    await expect(
      reader.persist({
        run,
        requestMessageId: 'TEST-new',
        text: 'x'.repeat(2000),
        origin: { kind: 'human' as const },
        isMeta: false as const,
      })
    ).rejects.toThrow('size limit');
    expect(await readFile(path, 'utf8')).toBe(saved);
  });

  it('never replaces corrupt canonical history with a new human record', async () => {
    const { reader, run, path } = await setup();
    await writeFile(path, 'TEST corrupt history');
    await expect(
      reader.persist({
        run,
        requestMessageId: 'TEST-new',
        text: 'Question',
        origin: { kind: 'human' as const },
        isMeta: false as const,
      })
    ).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('TEST corrupt history');
  });

  it('does not persist a human row after its run loses authority before atomic commit', async () => {
    const { reader, run, path, assertCurrent } = await setup();
    const before = await readFile(path, 'utf8');
    const original = await import('node:fs');
    const open = original.promises.open.bind(original.promises);
    const spy = vi.spyOn(original.promises, 'open').mockImplementationOnce(async (...args) => {
      assertCurrent.mockImplementation(() => {
        throw new Error('TEST invalidated during save');
      });
      return open(...args);
    });
    try {
      await expect(
        reader.persist({
          run,
          requestMessageId: 'TEST-new',
          text: 'Question',
          origin: { kind: 'human' as const },
          isMeta: false as const,
        })
      ).rejects.toThrow('invalidated during save');
    } finally {
      spy.mockRestore();
    }
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('requires an explicit absolute canonical teams root', () => {
    for (const teamsRoot of ['teams', join(tmpdir(), 'not-teams')]) {
      expect(
        () =>
          new NodeLeadRequestHistory({
            teamsRoot,
            leadName: () => 'team-lead',
            assertCurrent: () => undefined,
          })
      ).toThrow('absolute canonical');
    }
  });
});
