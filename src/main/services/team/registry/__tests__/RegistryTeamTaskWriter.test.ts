// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import {
  RegistryStatusConflictError,
  RegistryTaskRequestFailedError,
} from '../RegistryTaskClientErrors';
import { registryTaskId } from '../RegistryTaskIdentity';
import { RegistryTeamTaskWriteError, RegistryTeamTaskWriter } from '../RegistryTeamTaskWriter';

import type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskStatusResult,
  RegistryTaskGenesisReplayRecord,
  RegistryTaskWriteResult,
  RegistryTaskUpsertResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  UpsertRegistryTaskInput,
} from '../RegistryTaskClientTypes';
import type {
  RegistryTaskGenesisSigner,
  RegistryTeamTaskClientPort,
} from '../RegistryTeamTaskWriter';
import type { RegistryRegistrationIdentity } from '@shared/types';

const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const TEAM = 'alpha-team';
const TEAM_ID = 'registry-team-alpha';
const NOW = '2026-01-01T00:00:00.000Z';

const scopedTaskId = (localId: string): string =>
  registryTaskId({ project: PROJECT, spec: SPEC, localId });

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function makeTempBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-task-writer-'));
  tempPaths.push(dir);
  return dir;
}

function registryTask(localId: string, overrides: Partial<RegistryTask> = {}): RegistryTask {
  return {
    canonicalId: `${SPEC}:TASK-${localId}`,
    specSlug: SPEC,
    localId,
    title: `Task ${localId}`,
    description: null,
    creationToken: null,
    status: 'todo',
    phase: null,
    owner: null,
    tracking: null,
    contentHash: null,
    source: {
      path: null,
      startLine: null,
      startColumn: null,
      endLine: null,
      endColumn: null,
    },
    requirements: ['FR-1'],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    refs: [],
    ...overrides,
  };
}

function applied(): RegistryTaskWriteResult {
  return { outcome: 'APPLIED', transitions: [], refusal: null };
}

class FakeRegistryClient implements RegistryTeamTaskClientPort {
  tasks: RegistryTask[] = [];
  readonly readTasksDocumentSha = vi.fn(async () => 'a'.repeat(64));
  readonly listTasks = vi.fn(async (_input: ListRegistryTasksInput) => this.tasks);
  readonly replayTaskGenesisRequest = vi.fn(
    async (_input: {
      replay: RegistryTaskGenesisReplayRecord;
      expectedRegistrationIdentity: RegistryRegistrationIdentity;
    }): Promise<RegistryTaskWriteResult> => applied()
  );
  readonly confirmTaskCreation = vi.fn(
    async (_input: { project: string; spec: string; entity: string; creationToken: string }) =>
      false
  );
  readonly upsertTask = vi.fn(
    async (_input: UpsertRegistryTaskInput): Promise<RegistryTaskUpsertResult> => applied()
  );
  readonly replaceTaskStatus = vi.fn(
    async (_input: ReplaceRegistryTaskStatusInput): Promise<RegistryTaskStatusResult> => ({
      outcome: 'APPLIED' as const,
      transitions: [],
    })
  );
  readonly replaceTaskOwner = vi.fn(
    async (_input: ReplaceRegistryTaskOwnerInput): Promise<RegistryTaskWriteResult> => applied()
  );
  readonly replaceTaskLinks = vi.fn(
    async (_input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult> => applied()
  );
}

function createWriter(
  client: FakeRegistryClient,
  options: {
    expectedRegistrationIdentity?: RegistryRegistrationIdentity;
    signer?: RegistryTaskGenesisSigner;
  } = {}
): {
  writer: RegistryTeamTaskWriter;
  store: ExecutionTaskStore;
} {
  const store = new ExecutionTaskStore({ basePath: makeTempBasePath() });
  return {
    store,
    writer: new RegistryTeamTaskWriter({
      teamName: TEAM,
      teamId: TEAM_ID,
      binding: { project: PROJECT, spec: SPEC },
      client,
      executionStore: store,
      expectedRegistrationIdentity: options.expectedRegistrationIdentity,
      signTaskGenesisAttestation: options.signer,
      clock: () => new Date(NOW),
    }),
  };
}

async function expectWriteError(
  run: Promise<unknown>,
  code: RegistryTeamTaskWriteError['code']
): Promise<RegistryTeamTaskWriteError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(RegistryTeamTaskWriteError);
  const typed = error as RegistryTeamTaskWriteError;
  expect(typed.code).toBe(code);
  return typed;
}

describe('RegistryTeamTaskWriter creation', () => {
  it('replays an applied command without re-admitting an archived group', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);
    const input = {
      subject: 'Group task',
      requirements: ['FR-1'],
      groupChatId: 'group',
      commandIdempotencyKey: 'group-command',
    };
    const admission = vi.fn(async () => undefined);
    await writer.createTask(input, admission);
    client.tasks = [registryTask('1', { title: 'Group task' })];
    admission.mockRejectedValueOnce(new Error('group archived'));
    const replay = await writer.createTask(input, admission);
    expect(replay.createdInAttempt).toBe(false);
    expect(admission).toHaveBeenCalledTimes(1);
    await expect(
      writer.createTask({ ...input, commandIdempotencyKey: 'new-command' }, admission)
    ).rejects.toThrow('group archived');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('reserves ids occupied by any team in the spec, including deleted ones', async () => {
    const client = new FakeRegistryClient();
    const occupied = [registryTask('1'), registryTask('2', { status: 'deleted' })];
    client.listTasks.mockImplementation(async () => occupied);
    const { writer, store } = createWriter(client);

    const created = await writer.createTask({ subject: 'New', requirements: ['FR-1'] });

    expect(created.task.id).toBe(scopedTaskId('3'));
    // The registry scopes tasks by project and spec only; it declares no team
    // id, so every id used inside this spec is reserved.
    expect(client.listTasks.mock.calls[0][0]).toEqual({
      project: PROJECT,
      spec: SPEC,
      statuses: [
        'planned',
        'todo',
        'ready',
        'in-progress',
        'blocked',
        'done',
        'deleted',
        'deferred',
        'unknown',
      ],
    });
    expect(client.upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({ localId: '3', teamId: TEAM_ID, expectedSha: 'a'.repeat(64) })
    );
    expect(store.read(TEAM, scopedTaskId('1'))).toBeNull();
    expect(store.read(TEAM, scopedTaskId('2'))).toBeNull();
    // Without a team id the registry cannot hide another team's task; the board
    // simply does not surface ids it never created.
    expect(client.listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: PROJECT, spec: SPEC })
    );
    expect(client.listTasks).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ teamId: expect.anything() })
    );
  });

  it('does not create a task when the spec-wide allocation query fails', async () => {
    const client = new FakeRegistryClient();
    const failure = new Error('registry unavailable');
    client.listTasks.mockRejectedValueOnce(failure);
    const { writer } = createWriter(client);

    await expect(writer.createTask({ subject: 'New', requirements: ['FR-1'] })).rejects.toBe(
      failure
    );
    expect(client.upsertTask).not.toHaveBeenCalled();
  });

  it('fences allocation with the pre-list document hash and releases a refused reservation', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);
    const input = { subject: 'Fenced', requirements: ['FR-1'], commandIdempotencyKey: 'fenced' };
    client.upsertTask.mockRejectedValueOnce(
      new RegistryTaskRequestFailedError('upsert_task', 'CONFLICT', 'document changed', true)
    );
    await expectWriteError(writer.createTask(input), 'REGISTRY_REFUSED');
    expect(client.readTasksDocumentSha.mock.invocationCallOrder[0]).toBeLessThan(
      client.listTasks.mock.invocationCallOrder[0]
    );
    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({
      localId: '1',
      expectedSha: 'a'.repeat(64),
    });
    client.tasks = [registryTask('1')];
    const retried = await writer.createTask(input);
    expect(retried.task.id).toBe(scopedTaskId('2'));
    expect(client.upsertTask.mock.calls[1][0]).toMatchObject({
      localId: '2',
      expectedSha: 'a'.repeat(64),
    });
  });

  it('reports an invalid requirement as a refusal and releases its reservation', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);
    const input = { subject: 'Task', requirements: ['FR-9'], commandIdempotencyKey: 'invalid-fr' };
    client.upsertTask.mockRejectedValueOnce(
      new RegistryTaskRequestFailedError(
        'upsert_task',
        'TEAM_REQUIREMENT_INVALID',
        'Requirement does not exist',
        false
      )
    );
    const failure = await expectWriteError(writer.createTask(input), 'REGISTRY_REFUSED');
    expect(failure.details.registryCode).toBe('TEAM_REQUIREMENT_INVALID');
    await writer.createTask({ ...input, requirements: ['FR-1'] });
    expect(client.upsertTask.mock.calls[1][0].localId).toBe('1');
  });

  it('refuses before any registry request when requirements are missing', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.createTask({ subject: 'Broken task', requirements: [] }),
      'REQUIREMENTS_REQUIRED'
    );
    expect(client.upsertTask).not.toHaveBeenCalled();
    expect(client.readTasksDocumentSha).not.toHaveBeenCalled();
    expect(client.listTasks).not.toHaveBeenCalled();
  });

  it('refuses an initially completed required-artifact task before registry mutation', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.createTask({
        subject: 'Already complete',
        requirements: ['FR-1'],
        status: 'completed',
        executionPatch: {
          artifactRequirement: { required: true, expectedFilename: 'proof.pdf' },
        },
      }),
      'STATUS_UNSUPPORTED'
    );
    expect(client.readTasksDocumentSha).not.toHaveBeenCalled();
    expect(client.listTasks).not.toHaveBeenCalled();
    expect(client.upsertTask).not.toHaveBeenCalled();
  });

  it('creates a required-file task through the ordinary API and keeps its local requirement', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Required file',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'required-file',
      executionPatch: {
        artifactRequirement: { required: true, expectedFilename: 'proof.pdf' },
      },
    };
    const created = await writer.createTask(input);
    expect(created.createdInAttempt).toBe(true);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    const request = client.upsertTask.mock.calls[0][0];
    expect(request).toMatchObject({
      localId: '1',
      expectedSha: 'a'.repeat(64),
      requestId: expect.any(String),
      creationToken: expect.any(String),
    });
    expect(request).not.toHaveProperty('policy');
    expect(request).not.toHaveProperty('expectedRegistrationIdentity');
    expect(request).not.toHaveProperty('genesisAttestations');
    expect(store.read(TEAM, scopedTaskId('1'))?.artifactRequirement).toEqual(
      input.executionPatch.artifactRequirement
    );
    client.tasks = [
      registryTask('1', { title: input.subject, creationToken: request.creationToken }),
    ];
    const replay = await writer.createTask(input);
    expect(replay.createdInAttempt).toBe(false);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(store.read(TEAM, scopedTaskId('1'))?.artifactRequirement).toEqual(
      input.executionPatch.artifactRequirement
    );
  });

  it('recovers a marked unsigned required-file reservation only after exact confirmation', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Uncertain task',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'uncertain-required-file',
      executionPatch: { artifactRequirement: { required: true, expectedFilename: 'proof.pdf' } },
    };
    client.upsertTask.mockRejectedValueOnce(new Error('response lost'));
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    const journalPath = path.join(store.getTeamPath(TEAM), '.creation-commands', 'journal.json');
    const before = fs.readFileSync(journalPath, 'utf8');
    const entry = JSON.parse(before)[0];
    expect(entry.creationProtocol).toBe('unsigned-local-artifact-v1');
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before);
    client.confirmTaskCreation.mockResolvedValue(true);
    client.tasks = [registryTask('1', { title: input.subject, creationToken: 'different-token' })];
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before);
    client.tasks = [
      registryTask('1', { title: input.subject, creationToken: entry.creationToken }),
    ];
    const recovered = await writer.createTask(input);
    expect(recovered.createdInAttempt).toBe(false);
    expect(client.confirmTaskCreation).toHaveBeenLastCalledWith({
      project: PROJECT,
      spec: SPEC,
      entity: '1',
      creationToken: entry.creationToken,
    });
    expect(store.read(TEAM, scopedTaskId('1'))?.artifactRequirement).toEqual(
      input.executionPatch.artifactRequirement
    );
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(client.replayTaskGenesisRequest).not.toHaveBeenCalled();
  });

  it('preserves an unmarked legacy pending reservation without confirmation or replay', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Legacy task',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'legacy-required-file',
      executionPatch: { artifactRequirement: { required: true, expectedFilename: 'proof.pdf' } },
    };
    client.upsertTask.mockRejectedValueOnce(new Error('response lost'));
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    const journalPath = path.join(store.getTeamPath(TEAM), '.creation-commands', 'journal.json');
    const entries = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    delete entries[0].creationProtocol;
    fs.writeFileSync(journalPath, JSON.stringify(entries));
    const before = fs.readFileSync(journalPath, 'utf8');
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(client.confirmTaskCreation).not.toHaveBeenCalled();
    expect(client.replayTaskGenesisRequest).not.toHaveBeenCalled();
  });

  it('preserves a prior signed GENESIS journal without replaying or confirming it', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Previously signed',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'previously-signed',
      executionPatch: { artifactRequirement: { required: true, expectedFilename: 'proof.pdf' } },
    };
    client.upsertTask.mockRejectedValueOnce(new Error('response lost'));
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    const journalPath = path.join(store.getTeamPath(TEAM), '.creation-commands', 'journal.json');
    const entries = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const entry = entries[0];
    const payload = Array(25).fill(null);
    payload[14] = 'batch';
    payload[17] = entry.requestId;
    payload[18] = 'digest';
    const challenge = { operationId: 'operation', nonce: 'nonce', keyId: 'key', payload };
    const attestation = { ...challenge, signature: 'signature' };
    entry.genesisReplay = {
      challenge: {
        batchId: 'batch',
        requestId: entry.requestId,
        payloadDigest: 'digest',
        challenges: [challenge],
      },
      attestation,
      requestArguments: {
        requestId: entry.requestId,
        operations: [
          {
            localId: entry.taskId,
            creationToken: entry.creationToken,
            expectedSha: entry.expectedSha,
          },
        ],
        genesisAttestations: [attestation],
      },
    };
    fs.writeFileSync(journalPath, JSON.stringify(entries));
    const before = fs.readFileSync(journalPath, 'utf8');
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(client.confirmTaskCreation).not.toHaveBeenCalled();
    expect(client.replayTaskGenesisRequest).not.toHaveBeenCalled();
  });

  it('creates the task in the registry and records the creation locally', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);

    const { task, createdInAttempt } = await writer.createTask({
      subject: 'Implement balancer cap',
      description: 'Body text',
      requirements: ['FR-11.5'],
      owner: 'lead',
      tracking: 'track-1',
    });

    expect(createdInAttempt).toBe(true);
    expect(task.id).toBe(scopedTaskId('1'));
    expect(task.subject).toBe('Implement balancer cap');
    expect(task.status).toBe('pending');
    expect(task.owner).toBe('lead');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({
      project: PROJECT,
      spec: SPEC,
      localId: '1',
      title: 'Implement balancer cap',
      requirements: ['FR-11.5'],
      status: 'todo',
      owner: 'lead',
      tracking: 'track-1',
      description: 'Body text',
    });

    const record = store.read(TEAM, scopedTaskId('1'));
    expect(record?.historyEvents).toHaveLength(1);
    expect(record?.historyEvents[0]).toMatchObject({ type: 'task_created', status: 'pending' });
    expect(record?.workIntervals).toEqual([]);
  });

  it('starts the task and opens a work interval when it is created with an owner', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);

    const { task } = await writer.createTask({
      subject: 'Started task',
      requirements: ['FR-1'],
      owner: 'lead',
      startImmediately: true,
    });

    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({ status: 'in-progress' });
    expect(task.status).toBe('in_progress');
    expect(store.read(TEAM, scopedTaskId('1'))?.workIntervals).toEqual([{ startedAt: NOW }]);
  });

  it('replays an idempotent creation instead of creating a second task', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);

    const first = await writer.createTask({
      subject: 'Once',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'idem-1',
    });
    client.tasks = [registryTask('1')];
    const second = await writer.createTask({
      subject: 'Once',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'idem-1',
    });

    expect(first.task.id).toBe(scopedTaskId('1'));
    expect(second.createdInAttempt).toBe(false);
    expect(second.task.id).toBe(scopedTaskId('1'));
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('replays a committed command after writer restart and preserves execution metadata', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Durable',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'key',
      commandId: 'command-1',
      projectPath: '/old',
      executionPatch: { prompt: 'instructions' },
    };
    await writer.createTask(input);
    client.tasks = [registryTask('1', { title: 'Durable' })];
    const restarted = new RegistryTeamTaskWriter({
      teamName: TEAM,
      teamId: TEAM_ID,
      binding: { project: PROJECT, spec: SPEC },
      client,
      executionStore: store,
      clock: () => new Date(NOW),
    });
    const replay = await restarted.createTask({ ...input, projectPath: '/new' });
    expect(replay.createdInAttempt).toBe(false);
    expect(replay.task.prompt).toBe('instructions');
    expect(replay.task.projectPath).toBe('/old');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    await expectWriteError(
      restarted.createTask({ ...input, subject: 'changed' }),
      'IDEMPOTENCY_CONFLICT'
    );
  });

  it('does not submit a second create after an unknown registry outcome', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    client.upsertTask.mockRejectedValueOnce(new Error('connection lost'));
    const input = {
      subject: 'Uncertain',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'uncertain',
    };
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    const restarted = new RegistryTeamTaskWriter({
      teamName: TEAM,
      teamId: TEAM_ID,
      binding: { project: PROJECT, spec: SPEC },
      client,
      executionStore: store,
    });
    await expectWriteError(restarted.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost create response only after the authoritative branch confirms its marker', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Recover me',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'recovery-key',
      projectPath: '/original',
      executionPatch: { prompt: 'original work' },
    };
    client.upsertTask.mockImplementationOnce(async (operation) => {
      client.tasks = [
        registryTask('1', { title: 'Edited remotely', creationToken: operation.creationToken }),
      ];
      throw new Error('response lost');
    });
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    client.confirmTaskCreation.mockResolvedValueOnce(true);
    const restarted = new RegistryTeamTaskWriter({
      teamName: TEAM,
      teamId: TEAM_ID,
      binding: { project: PROJECT, spec: SPEC },
      client,
      executionStore: store,
    });
    const recovered = await restarted.createTask({ ...input, projectPath: '/changed' });
    expect(recovered.createdInAttempt).toBe(false);
    expect(recovered.task).toMatchObject({
      id: scopedTaskId('1'),
      subject: 'Edited remotely',
      projectPath: '/original',
      prompt: 'original work',
    });
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(
      store
        .read(TEAM, scopedTaskId('1'))
        ?.historyEvents.filter((event) => event.type === 'task_created')
    ).toHaveLength(1);
  });

  it('does not accept an unrelated task even when remote confirmation says the marker exists', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    client.upsertTask.mockRejectedValueOnce(new Error('response lost'));
    const input = {
      subject: 'Uncertain',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'different',
    };
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    client.tasks = [registryTask('1', { creationToken: 'another-command' })];
    client.confirmTaskCreation.mockResolvedValueOnce(true);
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(store.read(TEAM, scopedTaskId('1'))).toBeNull();
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('finishes local execution metadata after the registry committed but the local write failed', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Local failure',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'local-failure',
    };
    client.upsertTask.mockImplementationOnce(async (operation) => {
      client.tasks = [
        registryTask('1', { title: input.subject, creationToken: operation.creationToken }),
      ];
      return applied();
    });
    vi.spyOn(store, 'write').mockImplementationOnce(() => {
      throw new Error('disk temporarily unavailable');
    });
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    client.confirmTaskCreation.mockResolvedValueOnce(true);
    const recovered = await writer.createTask(input);
    expect(recovered.createdInAttempt).toBe(false);
    expect(
      store
        .read(TEAM, scopedTaskId('1'))
        ?.historyEvents.filter((event) => event.type === 'task_created')
    ).toHaveLength(1);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('preserves a supplied creation event without adding a duplicate during recovery', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const created = {
      id: 'original-event',
      timestamp: NOW,
      type: 'task_created' as const,
      status: 'pending' as const,
      actor: 'lead',
    };
    const input = {
      subject: 'Imported task',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'imported',
      executionPatch: { historyEvents: [created] },
    };
    client.upsertTask.mockImplementationOnce(async (operation) => {
      client.tasks = [registryTask('1', { creationToken: operation.creationToken })];
      return applied();
    });
    vi.spyOn(store, 'write').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    client.confirmTaskCreation.mockResolvedValueOnce(true);
    await writer.createTask(input);
    expect(store.read(TEAM, scopedTaskId('1'))?.historyEvents).toEqual([created]);
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite unrelated execution history when recovering a confirmed creation', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);
    const input = {
      subject: 'Uncertain',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'existing-local',
    };
    client.upsertTask.mockImplementationOnce(async (operation) => {
      client.tasks = [registryTask('1', { creationToken: operation.creationToken })];
      throw new Error('response lost');
    });
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    store.write(TEAM, scopedTaskId('1'), { prompt: 'unrelated existing work' });
    client.confirmTaskCreation.mockResolvedValueOnce(true);
    await expectWriteError(writer.createTask(input), 'CREATION_OUTCOME_UNKNOWN');
    expect(store.read(TEAM, scopedTaskId('1'))?.prompt).toBe('unrelated existing work');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('sends completed as the initial registry status and rejects deleted before writing', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);
    await writer.createTask({ subject: 'Finished', requirements: ['FR-1'], status: 'completed' });
    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({ status: 'done' });
    await expectWriteError(
      writer.createTask({ subject: 'Deleted', requirements: ['FR-1'], status: 'deleted' }),
      'STATUS_UNSUPPORTED'
    );
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });

  it('sends multiline descriptions without trimming or interpreting task headings', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);
    const description = ' line one\n## TASK-99: injected\n**Status:** done\n';
    const result = await writer.createTask({
      subject: 'Description',
      description,
      requirements: ['FR-1'],
    });
    expect(client.upsertTask.mock.calls[0][0].description).toBe(description);
    expect(result.task.description).toBe(description);
  });
});

describe('RegistryTeamTaskWriter status', () => {
  it('sends the last read as expectedStatus', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'todo' })];
    const { writer } = createWriter(client);

    await writer.replaceStatus({ taskId: '1', to: 'in_progress', actor: 'alice' });

    expect(client.replaceTaskStatus.mock.calls[0][0]).toMatchObject({
      entity: '1',
      status: 'in-progress',
      expectedStatus: 'todo',
    });
  });

  it('raises a typed STATUS_CONFLICT and writes no local status history', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'todo' })];
    client.replaceTaskStatus.mockRejectedValueOnce(
      new RegistryStatusConflictError({
        operation: 'replaceTaskStatus',
        message: 'STATUS_CONFLICT',
        currentStatus: 'done',
        expectedStatus: 'todo',
        localId: '1',
      })
    );
    const { writer, store } = createWriter(client);

    const error = await expectWriteError(
      writer.replaceStatus({ taskId: '1', to: 'completed' }),
      'STATUS_CONFLICT'
    );

    expect(error.taskId).toBe('1');
    expect(error.details).toMatchObject({ currentStatus: 'done', expectedStatus: 'todo' });
    expect(store.read(TEAM, scopedTaskId('1'))).toBeNull();
  });

  it('deletes and restores using registry status preconditions', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'in-progress' })];
    const { writer, store } = createWriter(client);
    store.write(TEAM, scopedTaskId('1'), {
      workIntervals: [{ startedAt: '2025-01-01T00:00:00.000Z' }],
    });
    await writer.replaceStatus({ taskId: '1', to: 'deleted' });
    expect(client.replaceTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'deleted', expectedStatus: 'in-progress' })
    );
    expect(store.read(TEAM, scopedTaskId('1'))?.workIntervals[0].completedAt).toBe(NOW);
    client.tasks = [registryTask('1', { status: 'deleted' })];
    await expectWriteError(writer.replaceStatus({ taskId: '1', to: 'pending' }), 'STATUS_CONFLICT');
    await writer.replaceStatus({ taskId: '1', to: 'pending', expectedStatus: 'deleted' });
    expect(client.replaceTaskStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'todo', expectedStatus: 'deleted' })
    );
  });

  it('closes the work interval and records the transition locally', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'in-progress' })];
    const { writer, store } = createWriter(client);
    store.write(TEAM, scopedTaskId('1'), {
      workIntervals: [{ startedAt: '2025-12-31T23:00:00.000Z' }],
    });

    await writer.replaceStatus({ taskId: '1', to: 'completed', actor: 'alice' });

    const record = store.read(TEAM, scopedTaskId('1'));
    expect(record?.workIntervals).toEqual([
      { startedAt: '2025-12-31T23:00:00.000Z', completedAt: NOW },
    ]);
    expect(record?.historyEvents.at(-1)).toMatchObject({
      type: 'status_changed',
      from: 'in_progress',
      to: 'completed',
      actor: 'alice',
    });
  });
});

describe('RegistryTeamTaskWriter review execution', () => {
  it('records review decisions and closes active intervals without local canonical writes', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'done', owner: 'alice' })];
    const { writer, store } = createWriter(client);
    await writer.transitionReview({
      taskId: '1',
      action: 'request',
      actor: 'lead',
      reviewer: 'bob',
    });
    store.write(TEAM, scopedTaskId('1'), {
      reviewIntervals: [{ reviewer: 'bob', startedAt: '2025-12-31T23:00:00.000Z' }],
    });
    await writer.transitionReview({ taskId: '1', action: 'approve', actor: 'bob' });
    expect(store.read(TEAM, scopedTaskId('1'))).toMatchObject({
      reviewState: 'approved',
      reviewIntervals: [
        { reviewer: 'bob', startedAt: '2025-12-31T23:00:00.000Z', completedAt: NOW },
      ],
      historyEvents: [
        expect.objectContaining({ type: 'review_requested', actor: 'lead', reviewer: 'bob' }),
        expect.objectContaining({ type: 'review_approved', actor: 'bob' }),
      ],
    });
    expect(client.upsertTask).not.toHaveBeenCalled();
  });
});

describe('RegistryTeamTaskWriter owner and links', () => {
  it('replaces the owner through the registry and records the change locally', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { owner: 'alice' })];
    const { writer, store } = createWriter(client);

    await writer.replaceOwner({ taskId: '1', owner: 'bob' });

    expect(client.replaceTaskOwner.mock.calls[0][0]).toMatchObject({ entity: '1', owner: 'bob' });
    expect(store.read(TEAM, scopedTaskId('1'))?.historyEvents.at(-1)).toMatchObject({
      type: 'owner_changed',
      from: 'alice',
      to: 'bob',
    });
  });

  it('clears an owner through the registry and records the change', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { owner: 'alice' })];
    const { writer, store } = createWriter(client);
    await writer.replaceOwner({ taskId: '1', owner: null });
    expect(client.replaceTaskOwner).toHaveBeenCalledWith(
      expect.objectContaining({ entity: '1', owner: null })
    );
    expect(store.read(TEAM, scopedTaskId('1'))?.historyEvents.at(-1)).toMatchObject({
      type: 'owner_changed',
      from: 'alice',
    });
  });

  it('writes blockedBy as a registry dependsOn link', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    const { writer } = createWriter(client);

    await writer.addLink({ taskId: '1', targetId: '2', type: 'blockedBy' });

    expect(client.replaceTaskLinks.mock.calls[0][0]).toMatchObject({
      entity: '1',
      dependsOn: [`${SPEC}:TASK-2`],
    });
  });

  it('writes related links in both directions and removes them from both tasks', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    client.replaceTaskLinks.mockImplementation(async (input) => {
      const target = client.tasks.find((task) => task.localId === input.entity)!;
      target.refs = [...(input.refs ?? target.refs)];
      return applied();
    });
    const { writer } = createWriter(client);

    await writer.addLink({ taskId: '1', targetId: '2', type: 'related' });
    expect(client.tasks.map((task) => task.refs)).toEqual([[`${SPEC}:TASK-2`], [`${SPEC}:TASK-1`]]);
    expect(client.replaceTaskLinks.mock.calls[0][0].expectedSha).toBe('a'.repeat(64));
    expect(client.replaceTaskLinks.mock.calls[1][0].expectedSha).toBe('a'.repeat(64));
    await writer.removeLink({ taskId: '2', targetId: '1', type: 'related' });
    expect(client.tasks.map((task) => task.refs)).toEqual([[], []]);
  });

  it('rejects normalized self-links and unknown targets without writing', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1')];
    const { writer } = createWriter(client);
    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: 'TASK-1', type: 'related' }),
      'LINK_CYCLE'
    );
    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'related' }),
      'TASK_NOT_FOUND'
    );
    expect(client.replaceTaskLinks).not.toHaveBeenCalled();
  });

  it('compensates a confirmed reciprocal refusal using a guarded preimage', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    let calls = 0;
    client.replaceTaskLinks.mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2)
        throw new RegistryTaskRequestFailedError('replace_task_links', 'CONFLICT', 'changed', true);
      const target = client.tasks.find((task) => task.localId === input.entity)!;
      target.refs = [...(input.refs ?? target.refs)];
      return applied();
    });
    const { writer } = createWriter(client);
    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'related' }),
      'REGISTRY_REFUSED'
    );
    expect(client.tasks.map((task) => task.refs)).toEqual([[], []]);
    expect(client.replaceTaskLinks.mock.calls[2][0]).toMatchObject({
      entity: '1',
      refs: [],
      expectedSha: 'a'.repeat(64),
    });
  });

  it('reports a partial relationship when concurrent mutation prevents compensation', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    let calls = 0;
    client.replaceTaskLinks.mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) {
        client.tasks[0].refs = [`${SPEC}:TASK-2`, `${SPEC}:TASK-3`];
        throw new RegistryTaskRequestFailedError('replace_task_links', 'CONFLICT', 'changed', true);
      }
      client.tasks[0].refs = [...(input.refs ?? [])];
      return applied();
    });
    const { writer } = createWriter(client);
    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'related' }),
      'RELATIONSHIP_PARTIAL'
    );
    expect(client.replaceTaskLinks).toHaveBeenCalledTimes(2);
    expect(client.tasks[0].refs).toEqual([`${SPEC}:TASK-2`, `${SPEC}:TASK-3`]);
  });

  it('reports uncertain reciprocal writes without unsafe rollback', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    client.replaceTaskLinks
      .mockResolvedValueOnce(applied())
      .mockRejectedValueOnce(new Error('connection lost'));
    const { writer } = createWriter(client);
    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'related' }),
      'RELATIONSHIP_OUTCOME_UNKNOWN'
    );
    expect(client.replaceTaskLinks).toHaveBeenCalledTimes(2);
  });

  it('rejects a blockedBy link that would close a dependency cycle', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [
      registryTask('1'),
      registryTask('2', { dependsOn: [`${SPEC}:TASK-3`] }),
      registryTask('3', { dependsOn: [`${SPEC}:TASK-1`] }),
    ];
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'blockedBy' }),
      'LINK_CYCLE'
    );
    expect(client.replaceTaskLinks).not.toHaveBeenCalled();
  });
});
