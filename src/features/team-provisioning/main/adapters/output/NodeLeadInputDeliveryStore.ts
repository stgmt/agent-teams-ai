import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { withFileLock } from '@main/services/team/fileLock';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { PreviousDurableRequestActiveError } from '../../../core/application/ports/LeadInputDelivery';

import type { TeamRunIdentity } from '../../../contracts';
import type {
  LeadInputClaim,
  LeadInputDelivery,
} from '../../../core/application/ports/LeadInputDelivery';
import type { PersistedLeadRequest } from '../../../core/application/ports/LeadRequestDeliveryPorts';

interface Dependencies {
  readonly teamsRoot: string;
  assertCurrent(run: Readonly<TeamRunIdentity>): void;
  readDelivered(run: Readonly<TeamRunIdentity>, requestMessageId: string): Promise<string | null>;
}

interface RecordValue {
  schemaVersion: 1;
  run: Readonly<TeamRunIdentity>;
  requestMessageId: string;
  textDigest: string;
  operationId: string;
  state: 'reserved' | 'unconfirmed' | 'sent';
}

function identity(request: PersistedLeadRequest): string {
  const run = request.run;
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
    request.requestMessageId,
  ]);
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The claim survives process failure. An uncertain write is never converted into permission to resend. */
export class NodeLeadInputDeliveryStore implements LeadInputDelivery {
  private readonly teamsRoot: string;

  constructor(private readonly deps: Dependencies) {
    if (!isAbsolute(deps.teamsRoot) || basename(deps.teamsRoot) !== 'teams')
      throw new Error('An absolute canonical teams directory is required');
    this.teamsRoot = resolve(deps.teamsRoot);
  }

  reserve(input: PersistedLeadRequest): Promise<void> {
    return this.withRecord(input, async (path, request, current) => {
      if (current) return;
      await this.write(path, request, {
        schemaVersion: 1,
        run: request.run,
        requestMessageId: request.requestMessageId,
        textDigest: digest(request.text),
        operationId: randomUUID(),
        state: 'reserved',
      });
    });
  }

  claim(input: PersistedLeadRequest): Promise<LeadInputClaim> {
    return this.withRecord(input, async (path, request, current) => {
      if (current && current.state !== 'reserved') return Object.freeze({ state: current.state });
      const value: RecordValue = {
        schemaVersion: 1,
        run: request.run,
        requestMessageId: request.requestMessageId,
        textDigest: digest(request.text),
        operationId: randomUUID(),
        state: 'unconfirmed',
      };
      await this.write(path, request, value);
      return Object.freeze({ state: 'claimed', operationId: value.operationId });
    });
  }

  sent(input: PersistedLeadRequest, operationId: string): Promise<void> {
    return this.withRecord(input, async (path, request, current) => {
      if (current?.operationId !== operationId || current.state === 'reserved')
        throw new Error('Lead input operation is not the current durable claim');
      if (current.state === 'sent') return;
      await this.write(path, request, { ...current, state: 'sent' });
    });
  }

  private async withRecord<T>(
    input: PersistedLeadRequest,
    action: (path: string, request: PersistedLeadRequest, current: RecordValue | null) => Promise<T>
  ): Promise<T> {
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
      !request.requestMessageId ||
      request.requestMessageId.length > 256 ||
      !request.text.trim() ||
      request.text.length > 64_000
    )
      throw new TypeError('An exact original human request is required');
    const team = join(this.teamsRoot, request.run.teamName);
    await this.directories(team);
    const directory = join(team, 'lead-input-delivery');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.directories(team, directory);
    const path = join(directory, `${digest(identity(request))}.json`);
    return withFileLock(
      join(directory, 'admission'),
      async () => {
        this.deps.assertCurrent(request.run);
        await this.directories(team, directory);
        const names = await fs.readdir(directory);
        for (const name of names) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const existing = await this.read(join(directory, name));
          if (
            existing &&
            name !==
              `${digest(identity({ ...request, run: existing.run, requestMessageId: existing.requestMessageId }))}.json`
          )
            throw new Error('Lead input metadata file identity differs');
          if (
            !existing ||
            identity({ ...request, run: existing.run, requestMessageId: '' }) !==
              identity({ ...request, requestMessageId: '' }) ||
            existing.requestMessageId === request.requestMessageId
          )
            continue;
          const delivered = await this.deps.readDelivered(request.run, existing.requestMessageId);
          this.deps.assertCurrent(request.run);
          if (!delivered) throw new PreviousDurableRequestActiveError();
        }
        const current = await this.read(path);
        if (
          current &&
          (identity({
            ...request,
            run: current.run,
            requestMessageId: current.requestMessageId,
          }) !== identity(request) ||
            current.textDigest !== digest(request.text))
        )
          throw new Error('Lead input metadata differs from the original request');
        this.deps.assertCurrent(request.run);
        return action(path, request, current);
      },
      { preventLiveOwnerTakeover: true }
    );
  }

  private async read(path: string): Promise<RecordValue | null> {
    const stat = await fs.lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32_768)
      throw new Error('Lead input metadata must be a bounded regular private file');
    const file = await fs.open(path, 'r');
    let raw: string;
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino
      )
        throw new Error('Lead input metadata must be a bounded regular private file');
      const bytes = Buffer.alloc(32_769);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 32_768) throw new Error('Lead input metadata size limit exceeded');
      raw = bytes.subarray(0, length).toString('utf8');
    } finally {
      await file.close();
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') throw new Error('Invalid lead input metadata');
    const row = value as RecordValue;
    if (
      row.schemaVersion !== 1 ||
      !row.run ||
      typeof row.operationId !== 'string' ||
      !row.operationId ||
      !['reserved', 'unconfirmed', 'sent'].includes(row.state) ||
      typeof row.requestMessageId !== 'string' ||
      !row.requestMessageId ||
      row.requestMessageId.length > 256 ||
      typeof row.textDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.textDigest) ||
      typeof row.run.appInstanceId !== 'string' ||
      typeof row.run.dataRootFingerprint !== 'string' ||
      !Number.isSafeInteger(row.run.connectionGeneration) ||
      typeof row.run.teamName !== 'string' ||
      typeof row.run.runId !== 'string'
    )
      throw new Error('Lead input metadata differs from the original request');
    return row;
  }

  private async write(
    path: string,
    request: PersistedLeadRequest,
    value: RecordValue
  ): Promise<void> {
    await atomicWriteAsync(path, JSON.stringify(value), {
      mode: 0o600,
      directoryMode: 0o700,
      durability: 'strict',
      beforeCommit: async () => {
        this.deps.assertCurrent(request.run);
        const team = join(this.teamsRoot, request.run.teamName);
        await this.directories(team, join(team, 'lead-input-delivery'));
        this.deps.assertCurrent(request.run);
      },
    });
  }

  private async directories(...paths: string[]): Promise<void> {
    for (const path of [this.teamsRoot, ...paths]) {
      const stat = await fs.lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        resolve(await fs.realpath(path)) !== resolve(path)
      )
        throw new Error('Lead input metadata directory must not be redirected');
    }
  }
}
