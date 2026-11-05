import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { withFileLock } from '@main/services/team/fileLock';
import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import type { TeamRunIdentity } from '../../../contracts';
import type { PersistedLeadRequest } from '../../../core/application/ports/LeadRequestDeliveryPorts';

interface Dependencies {
  readonly teamsRoot: string;
  leadName(run: Readonly<TeamRunIdentity>): string;
  assertCurrent(run: Readonly<TeamRunIdentity>): void;
}

const MAX_HISTORY_BYTES = 2 * 1024 * 1024;

/** Owns original human persistence in the selected canonical history, never inbox copies. */
export class NodeLeadRequestHistory {
  private readonly teamsRoot: string;

  constructor(private readonly deps: Dependencies) {
    if (!isAbsolute(deps.teamsRoot) || basename(deps.teamsRoot) !== 'teams')
      throw new Error('An absolute canonical teams directory is required');
    this.teamsRoot = resolve(deps.teamsRoot);
  }

  async persist(input: PersistedLeadRequest): Promise<void> {
    const request = Object.freeze({
      ...input,
      run: Object.freeze({ ...input.run }),
      origin: Object.freeze({ ...input.origin }),
    });
    this.deps.assertCurrent(request.run);
    const valid = validateTeamName(request.run.teamName);
    if (
      !valid.valid ||
      valid.value !== request.run.teamName ||
      request.origin.kind !== 'human' ||
      request.isMeta !== false ||
      typeof request.text !== 'string' ||
      !request.text.trim() ||
      request.text.length > 64_000 ||
      typeof request.requestMessageId !== 'string' ||
      request.requestMessageId.length === 0 ||
      request.requestMessageId !== request.requestMessageId.trim() ||
      request.requestMessageId.length > 256 ||
      Array.from(request.requestMessageId).some(
        (value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127
      )
    )
      throw new TypeError('An exact original human request is required');
    const leadName = this.deps.leadName(request.run);
    const lead = validateMemberName(leadName);
    if (!lead.valid || lead.value !== leadName) throw new Error('Configured lead is unavailable');
    const team = join(this.teamsRoot, request.run.teamName);
    await this.assertDirectories(team);
    const path = join(team, 'sentMessages.json');
    await withFileLock(
      path,
      async () => {
        this.deps.assertCurrent(request.run);
        await this.assertDirectories(team);
        const saved = (await this.readRows(path)) ?? [];
        const matches = saved.filter(
          (row) =>
            row !== null &&
            typeof row === 'object' &&
            'messageId' in row &&
            row.messageId === request.requestMessageId
        );
        if (matches.length) {
          const exact = await this.read(request.run, request.requestMessageId);
          if (exact?.text !== request.text)
            throw new Error('Canonical human request content differs');
          return;
        }
        const row = {
          from: 'user',
          to: leadName,
          source: 'user_sent',
          messageId: request.requestMessageId,
          leadSessionId: request.run.runId,
          text: request.text,
          timestamp: new Date().toISOString(),
          read: true,
        };
        const text = JSON.stringify([...saved, row], null, 2);
        if (Buffer.byteLength(text) > MAX_HISTORY_BYTES)
          throw new Error('Canonical human history size limit exceeded');
        await atomicWriteAsync(path, text, {
          mode: 0o600,
          directoryMode: 0o700,
          durability: 'strict',
          beforeCommit: async () => {
            this.deps.assertCurrent(request.run);
            await this.assertDirectories(team);
            this.deps.assertCurrent(request.run);
          },
        });
      },
      { preventLiveOwnerTakeover: true }
    );
    this.deps.assertCurrent(request.run);
  }

  async read(
    identity: Readonly<TeamRunIdentity>,
    requestMessageId: string
  ): Promise<PersistedLeadRequest | null> {
    const run = Object.freeze({ ...identity });
    const valid = validateTeamName(run.teamName);
    if (!valid.valid || valid.value !== run.teamName)
      throw new TypeError('Invalid exact team name');
    if (
      typeof requestMessageId !== 'string' ||
      !requestMessageId ||
      requestMessageId.length > 256 ||
      requestMessageId !== requestMessageId.trim() ||
      Array.from(requestMessageId).some(
        (value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127
      )
    )
      throw new TypeError('An exact human request identity is required');
    const leadName = this.deps.leadName(run);
    const lead = validateMemberName(leadName);
    if (!lead.valid || lead.value !== leadName) throw new Error('Configured lead is unavailable');
    const teamDirectory = join(this.teamsRoot, run.teamName);
    await this.assertDirectories(teamDirectory);
    const path = join(teamDirectory, 'sentMessages.json');
    const saved = await this.readRows(path);
    await this.assertDirectories(teamDirectory);
    if (!saved) return null;
    const matches = saved.filter(
      (row): row is Record<string, unknown> =>
        row !== null &&
        typeof row === 'object' &&
        'messageId' in row &&
        row.messageId === requestMessageId
    );
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('Persisted human request identity is ambiguous');
    const row = matches[0];
    if (
      row.from !== 'user' ||
      row.to !== leadName ||
      row.source !== 'user_sent' ||
      row.leadSessionId !== run.runId ||
      row.messageKind !== undefined ||
      row.relayOfMessageId !== undefined ||
      row.groupChatId !== undefined ||
      (row.isMeta !== undefined && row.isMeta !== false) ||
      (row.origin !== undefined &&
        (!row.origin ||
          typeof row.origin !== 'object' ||
          !('kind' in row.origin) ||
          row.origin.kind !== 'human')) ||
      typeof row.text !== 'string' ||
      !row.text.trim() ||
      row.text.length > 64_000
    )
      throw new Error('The exact original human request is unavailable');
    if (
      (row.attachments !== undefined &&
        (!Array.isArray(row.attachments) || row.attachments.length > 0)) ||
      (row.fileReferences !== undefined &&
        (!Array.isArray(row.fileReferences) || row.fileReferences.length > 0))
    )
      throw new Error('Persisted attachments require attachment-aware human request delivery');
    return Object.freeze({
      run,
      requestMessageId,
      text: row.text,
      origin: Object.freeze({ kind: 'human' as const }),
      isMeta: false,
    });
  }

  async readDelivered(
    identity: Readonly<TeamRunIdentity>,
    requestMessageId: string
  ): Promise<string | null> {
    const run = Object.freeze({ ...identity });
    const valid = validateTeamName(run.teamName);
    if (!valid.valid || valid.value !== run.teamName)
      throw new TypeError('Invalid exact team name');
    const teamDirectory = join(this.teamsRoot, run.teamName);
    await this.assertDirectories(teamDirectory);
    const inboxDirectory = join(teamDirectory, 'inboxes');
    const directory = await fs.lstat(inboxDirectory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!directory) return null;
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      resolve(await fs.realpath(inboxDirectory)) !== resolve(inboxDirectory)
    )
      throw new Error('Canonical reply inbox must not be redirected');
    const rows = await this.readRows(join(inboxDirectory, 'user.json'));
    await this.assertDirectories(teamDirectory);
    const lead = this.deps.leadName(run);
    const matches = (rows ?? []).filter((row): row is Record<string, unknown> => {
      if (!row || typeof row !== 'object') return false;
      const value = row as Record<string, unknown>;
      return (
        value.from === lead &&
        value.to === 'user' &&
        value.source === 'lead_process' &&
        value.leadSessionId === run.runId &&
        value.replyChannel === 'explicit' &&
        Array.isArray(value.replyToMessageIds) &&
        value.replyToMessageIds.length === 1 &&
        value.replyToMessageIds[0] === requestMessageId &&
        typeof value.text === 'string' &&
        !!value.text.trim() &&
        typeof value.messageId === 'string' &&
        (value.messageId === `lead-reply:${run.runId}:${requestMessageId}` ||
          /^lead-report:[A-Za-z0-9-]{1,256}$/.test(value.messageId))
      );
    });
    if (matches.length > 1) throw new Error('Persisted reply identity is ambiguous');
    return matches.length ? (matches[0].messageId as string) : null;
  }

  private async assertDirectories(teamDirectory: string): Promise<void> {
    for (const path of [this.teamsRoot, teamDirectory]) {
      const stat = await fs.lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Canonical human request directory must not be redirected');
      if (resolve(await fs.realpath(path)) !== resolve(path))
        throw new Error('Canonical human request directory must not be redirected');
    }
  }

  private async readRows(path: string): Promise<unknown[] | null> {
    const before = await fs.lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error('Canonical human history must be a regular private file');
    if (before.size > MAX_HISTORY_BYTES)
      throw new Error('Canonical human history size limit exceeded');
    const file = await fs.open(path, 'r');
    let raw: string;
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        throw new Error('Canonical human history must be a regular private file');
      const bytes = Buffer.alloc(MAX_HISTORY_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = await file.read(bytes, length, bytes.length - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      if (length > MAX_HISTORY_BYTES)
        throw new Error('Canonical human history size limit exceeded');
      raw = bytes.subarray(0, length).toString('utf8');
    } finally {
      await file.close();
    }
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('Canonical human history must contain message rows');
    return rows as unknown[];
  }
}
