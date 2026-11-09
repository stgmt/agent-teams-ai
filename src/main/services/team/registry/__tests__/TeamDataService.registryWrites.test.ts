import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../TeamDataService';
import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import {
  TaskAttestationJournal,
  type TaskAttestationJournalEntry,
} from '../../execution/TaskAttestationJournal';
import { taskPolicyDigest, type TaskPolicy } from '@main/services/identity/TaskAttestation';
import type { DesktopSigningKeyStore } from '@main/services/identity/DesktopSigningKeyStore';
import type { RegistryTaskClient } from '../RegistryTaskClient';
import type { RegistryTaskPolicyChangeReplayRecord } from '../RegistryTaskClientTypes';
import { TeamTaskAttachmentStore } from '../../TeamTaskAttachmentStore';
import type { TeamMetaFile } from '../../TeamMetaStore';
import { resolveTeamSpecBindings, TeamSpecBindingError } from '../TeamSpecBinding';

import type { RegistryTeamTaskWriter } from '../RegistryTeamTaskWriter';
import type { CreateTaskRequest, TeamConfig, TeamTask } from '@shared/types';
import type { AgentTeamsController } from 'agent-teams-controller';
import type { Mock } from 'vitest';

const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const TEAM = 'alpha-team';

type WriterOutcome = 'APPLIED' | 'UNCHANGED';

interface FakeWriter {
  replaceStatus: Mock<
    (input: {
      taskId: string;
      to: string;
      actor?: string;
    }) => Promise<{ outcome: WriterOutcome; transitions: [] }>
  >;
  replaceOwner: Mock<(input: { taskId: string; owner: string | null }) => Promise<WriterOutcome>>;
  createTask: Mock<
    (input: Record<string, unknown>) => Promise<{ task: TeamTask; createdInAttempt: boolean }>
  >;
  addLink: Mock<(input: Record<string, unknown>) => Promise<void>>;
  removeLink: Mock<(input: Record<string, unknown>) => Promise<void>>;
  updateCanonicalFields: Mock<(input: Record<string, unknown>) => Promise<void>>;
  applyExecutionPatch: Mock<(taskId: string, patch: Record<string, unknown>) => Promise<void>>;
  binding: { project: string; spec: string };
}

function makeFakeWriter(): FakeWriter {
  return {
    replaceStatus: vi.fn(async () => ({ outcome: 'APPLIED' as const, transitions: [] })),
    replaceOwner: vi.fn(async () => 'APPLIED' as const),
    createTask: vi.fn(async () => ({
      task: {
        id: '1',
        displayId: '1',
        subject: 'Registry task',
        status: 'pending',
      } as TeamTask,
      createdInAttempt: true,
    })),
    addLink: vi.fn(async () => undefined),
    removeLink: vi.fn(async () => undefined),
    updateCanonicalFields: vi.fn(async () => undefined),
    applyExecutionPatch: vi.fn(async () => undefined),
    binding: { project: PROJECT, spec: SPEC },
  };
}

function makeService(
  config: TeamConfig | null,
  writer: FakeWriter = makeFakeWriter(),
  executionTaskStore?: ExecutionTaskStore,
  artifactRequirement?: TeamTask['artifactRequirement'],
  taskAttachmentStore: TeamTaskAttachmentStore = new TeamTaskAttachmentStore(),
  options: {
    taskSigningKeyStoreFactory?: () => Promise<DesktopSigningKeyStore>;
    registryTaskCompletionClientFactory?: () => Promise<
      Pick<
        RegistryTaskClient,
        | 'requestTaskCompletionChallenge'
        | 'completeTask'
        | 'replayTaskCompletionRequest'
        | 'requestTaskPolicyChangeChallenge'
        | 'changeTaskPolicy'
        | 'replayTaskPolicyChangeRequest'
      >
    >;
    taskAttestationJournal?: TaskAttestationJournal;
    initialMetadata?: TeamMetaFile | null;
  } = {}
) {
  const setTaskStatus = vi.fn();
  const updateTaskFields = vi.fn();
  const linkTask = vi.fn();
  const unlinkTask = vi.fn();
  const task = { id: '9', subject: 'Local task', status: 'pending' } as TeamTask;
  const registryBinding = { project: PROJECT, spec: SPEC };
  let currentConfig = config;
  const linkedBindings =
    currentConfig?.specProject === PROJECT && currentConfig.specSlug === SPEC
      ? [registryBinding]
      : [];
  const registeredBindings = [...linkedBindings];
  const registryTask = {
    id: '1',
    displayId: '#TASK-1',
    subject: 'Registry task',
    status: 'pending',
    registryStatus: 'todo',
    registryTask: {
      canonicalId: `${SPEC}:TASK-1`,
      specSlug: SPEC,
      localId: 'TASK-1',
      title: 'Registry task',
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
      requirements: [],
      dependsOn: [],
      blocks: [],
      blockedBy: [],
    },
    specProject: PROJECT,
    specSlug: SPEC,
    artifactRequirement,
  } as TeamTask;
  const getTask = vi.fn(() => task);
  const createTask = vi.fn(
    async (input: Record<string, unknown>) =>
      ({ id: '9', subject: String(input.subject), status: 'pending' }) as TeamTask
  );
  const controllerFactory = (() =>
    ({
      taskBoard: { setTaskStatus, updateTaskFields, getTask, createTask, linkTask, unlinkTask },
    }) as unknown as AgentTeamsController) as (teamName: string) => AgentTeamsController;
  const configReader = {
    getConfigSnapshot: async () => currentConfig,
    getConfig: async () => currentConfig,
    updateConfig: async () => undefined,
    updateSpecBindings: async (
      teamName: string,
      specBindings: readonly NonNullable<TeamConfig['specBindings']>[number][]
    ) => {
      if (!currentConfig) return null;
      currentConfig = {
        ...currentConfig,
        specBindings: resolveTeamSpecBindings({ specBindings }, teamName),
      };
      return currentConfig;
    },
  };
  const provider = vi.fn(async () => writer as unknown as RegistryTeamTaskWriter);
  let metadata: TeamMetaFile | null =
    options.initialMetadata !== undefined
      ? options.initialMetadata
      : linkedBindings.length > 0
        ? {
            version: 1,
            cwd: 'C:/registry-test',
            createdAt: 1,
            registryTeamId: 'registry-team-alpha',
            registryRegistrationRequestId: 'registry-registration-request',
            registryRegistrationProject: PROJECT,
            registryRegistrationProtocol: 1,
            registryRegistrationIdentity: {
              securityStoreId: '123e4567-e89b-42d3-a456-426614174000',
              idp: 'test-idp',
              userId: 'test-user',
            },
            registryRegistrationCompleted: true,
            specBindings: linkedBindings,
          }
        : null;
  const teamMetaStore = {
    getMeta: vi.fn(async () => metadata),
    updateMeta: vi.fn(
      async (
        _teamName: string,
        update: (
          current: TeamMetaFile | null
        ) => Omit<TeamMetaFile, 'version'> | Promise<Omit<TeamMetaFile, 'version'>>
      ) => {
        metadata = { version: 1, ...(await update(metadata)) };
      }
    ),
  };
  const registryTaskProvider = {
    getBindings: vi.fn(async () => [...registeredBindings]),
    getTask: vi.fn(async () => ({ backed: true as const, task: registryTask })),
    getTaskScope: vi.fn(async () => registeredBindings[0] ?? null),
    linkTeamSpec: vi.fn(async (_teamId: string, binding: { project: string; spec: string }) => {
      if (
        !registeredBindings.some(
          (candidate) => candidate.project === binding.project && candidate.spec === binding.spec
        )
      ) {
        registeredBindings.push(binding);
      }
      return [...registeredBindings];
    }),
  };
  const service = new TeamDataService(
    configReader as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    controllerFactory,
    undefined,
    teamMetaStore as never,
    undefined,
    undefined,
    undefined,
    undefined,
    provider,
    registryTaskProvider as never,
    executionTaskStore,
    taskAttachmentStore,
    options.taskSigningKeyStoreFactory,
    options.registryTaskCompletionClientFactory,
    options.taskAttestationJournal
  );
  return {
    service,
    setTaskStatus,
    updateTaskFields,
    getTask,
    createTask,
    linkTask,
    unlinkTask,
    provider,
    writer,
    registryTask,
  };
}

type PolicyJournalEntry = Extract<TaskAttestationJournalEntry, { operation: 'policy' }>;

function makePendingPolicyEntry(): PolicyJournalEntry {
  const registration = {
    securityStoreId: '123e4567-e89b-42d3-a456-426614174000',
    idp: 'test-idp',
    userId: 'test-user',
  };
  const policy: TaskPolicy = { required: true, expectedFilename: 'proof.pdf' };
  const requestId = 'unknown-policy-request';
  const identity = {
    registry: registration.securityStoreId,
    idp: registration.idp,
    userId: registration.userId,
    teamId: 'registry-team-alpha',
    project: PROJECT,
    spec: SPEC,
    taskId: 'TASK-1',
    generation: 'generation-1',
    revision: 'b'.repeat(64),
  };
  const challengePayload = [
    'omp-spec-kit/task-policy-change@1',
    identity.registry,
    identity.idp,
    identity.userId,
    identity.teamId,
    identity.project,
    identity.spec,
    identity.taskId,
    identity.generation,
    identity.revision,
    0,
    null,
    1,
    taskPolicyDigest(policy),
    'c'.repeat(64),
    9_999_999_999_999,
    'd'.repeat(64),
    requestId,
  ] as const;
  const signature = Buffer.alloc(64).toString('base64url');
  const proof = {
    ...identity,
    previousVersion: 0,
    previousDigest: null,
    nextVersion: 1,
    policy,
    requestId,
  };
  const replay: RegistryTaskPolicyChangeReplayRecord = {
    requestId,
    project: PROJECT,
    spec: SPEC,
    teamId: identity.teamId,
    taskId: identity.taskId,
    expectedRegistrationIdentity: registration,
    policy,
    challengePayload,
    callerIdentity: identity,
    proof,
    signed: { payload: challengePayload, signature },
    requestArguments: {
      action: 'task_policy',
      project: PROJECT,
      requestId,
      teamId: identity.teamId,
      spec: SPEC,
      taskId: identity.taskId,
      policy,
      payload: challengePayload,
      signature,
    },
  };
  return { teamName: TEAM, taskId: '1', operation: 'policy', replay };
}

describe('TeamDataService task status routing', () => {
  let testRoot: string | null = null;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-task-service-'));
    setClaudeBasePathOverride(testRoot);
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (!testRoot) return;
    await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    testRoot = null;
  });

  it('updates local task status when the team has no spec binding', async () => {
    const { service, setTaskStatus, provider } = makeService({ name: TEAM });
    await service.updateTaskStatus(TEAM, '1', 'completed');
    expect(provider).not.toHaveBeenCalled();
    expect(setTaskStatus).toHaveBeenCalledWith('1', 'completed', undefined);
  });

  it('does not consult the attestation journal for local status or field writes', async () => {
    const journal = new TaskAttestationJournal(path.join(testRoot!, 'teams'));
    const run = vi.spyOn(journal, 'run').mockRejectedValue(new Error('journal unavailable'));
    const { service, setTaskStatus, updateTaskFields } = makeService(
      { name: TEAM },
      makeFakeWriter(),
      undefined,
      undefined,
      undefined,
      { taskAttestationJournal: journal }
    );
    await service.updateTaskStatus(TEAM, '9', 'in_progress', 'alice');
    await service.updateTaskStatus(TEAM, '9', 'completed', 'alice');
    await expect(
      service.updateTaskStatusWithReceipt(TEAM, '9', 'completed', 'alice', 'pending')
    ).resolves.toEqual([]);
    await service.updateTaskFields(TEAM, '9', { subject: 'Local change' });
    expect(setTaskStatus).toHaveBeenCalledWith('9', 'in_progress', 'alice');
    expect(setTaskStatus).toHaveBeenCalledWith('9', 'completed', 'alice');
    expect(updateTaskFields).toHaveBeenCalledWith('9', { subject: 'Local change' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects direct desktop completion when the required proof is missing', async () => {
    const { service, writer } = makeService(
      { name: TEAM, specProject: PROJECT, specSlug: SPEC },
      makeFakeWriter(),
      undefined,
      { required: true, expectedFilename: 'proof.pdf' }
    );
    await expect(service.updateTaskStatus(TEAM, '1', 'completed', 'alice')).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
    expect(writer.replaceStatus).not.toHaveBeenCalled();
  });

  it.each(['valid', 'missing', 'changed', 'unavailable'] as const)(
    'checks the actual local file for desktop completion: %s',
    async (scenario) => {
      setAppDataBasePath(testRoot);
      try {
        const client = {
          requestTaskCompletionChallenge: vi.fn(),
          completeTask: vi.fn(),
          replayTaskCompletionRequest: vi.fn(),
          requestTaskPolicyChangeChallenge: vi.fn(),
          changeTaskPolicy: vi.fn(),
          replayTaskPolicyChangeRequest: vi.fn(),
        };
        const { service, writer, registryTask } = makeService(
          { name: TEAM, specProject: PROJECT, specSlug: SPEC },
          makeFakeWriter(),
          undefined,
          undefined,
          undefined,
          { registryTaskCompletionClientFactory: async () => client }
        );
        const data = Buffer.from('local proof bytes');
        await service.updateTaskFields(TEAM, '1', {
          artifactRequired: true,
          artifactExpectedFilename: 'proof.pdf',
          artifactFile: { filename: 'proof.pdf', base64Data: data.toString('base64') },
        });
        const patch = writer.applyExecutionPatch.mock.calls.at(-1)?.[1];
        if (!patch) throw new Error('Missing artifact patch');
        Object.assign(registryTask, patch);
        const attachment = registryTask.attachments?.[0];
        if (!attachment?.filePath) throw new Error('Missing stored artifact path');
        if (scenario === 'missing')
          await fs.rename(attachment.filePath, `${attachment.filePath}.moved`);
        if (scenario === 'changed')
          await fs.writeFile(attachment.filePath, Buffer.from('changed bytes'));
        if (scenario === 'unavailable') {
          await fs.rename(
            path.dirname(attachment.filePath),
            `${path.dirname(attachment.filePath)}.moved`
          );
        }

        const completion = service.updateTaskStatus(TEAM, '1', 'completed', 'alice');
        if (scenario === 'valid') {
          await expect(completion).resolves.toBeUndefined();
          expect(writer.replaceStatus).toHaveBeenCalledWith({
            taskId: '1',
            to: 'completed',
            actor: 'alice',
            expectedStatus: 'pending',
          });
        } else {
          await expect(completion).rejects.toMatchObject({ code: 'REGISTRY_REFUSED' });
          expect(writer.replaceStatus).not.toHaveBeenCalled();
        }
        expect(client.requestTaskCompletionChallenge).not.toHaveBeenCalled();
        expect(client.requestTaskPolicyChangeChallenge).not.toHaveBeenCalled();
      } finally {
        setAppDataBasePath(null);
      }
    }
  );

  it('keeps ordinary bound status changes on the registry status writer', async () => {
    const { service, setTaskStatus, writer } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });
    const completeWithReceipt = vi.spyOn(service, 'updateTaskStatusWithReceipt');

    await service.updateTaskStatus(TEAM, '1', 'in_progress', 'alice');

    expect(writer.replaceStatus).toHaveBeenCalledWith({
      taskId: '1',
      to: 'in_progress',
      actor: 'alice',
    });
    expect(completeWithReceipt).not.toHaveBeenCalled();
    expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it('keeps ordinary bound completion on the registry status writer', async () => {
    const { service, writer } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });
    await service.updateTaskStatus(TEAM, '1', 'completed', 'alice');

    expect(writer.replaceStatus).toHaveBeenCalledWith({
      taskId: '1',
      to: 'completed',
      actor: 'alice',
      expectedStatus: 'pending',
    });
  });

  it('allows ordinary bound completion through the registry status writer', async () => {
    const { service, writer } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });

    await expect(
      service.updateTaskStatusWithReceipt(TEAM, '1', 'completed', 'alice', 'pending')
    ).resolves.toEqual([]);

    expect(writer.replaceStatus).toHaveBeenCalledWith({
      taskId: '1',
      to: 'completed',
      actor: 'alice',
      expectedStatus: 'pending',
    });
  });

  it('fails closed when specProject is set without specSlug', async () => {
    const { service, setTaskStatus } = makeService({
      name: TEAM,
      specProject: PROJECT,
    });

    await expect(service.updateTaskStatus(TEAM, '1', 'completed')).rejects.toBeInstanceOf(
      TeamSpecBindingError
    );
    expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it('creates tasks through the registry writer when bound', async () => {
    const { service, createTask, writer } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });

    const task = await service.createTask(TEAM, {
      specProject: PROJECT,
      specSlug: SPEC,
      subject: 'Registry task',
      requirements: ['FR-1'],
    });
    expect(task.id).toBe('1');
    expect(writer.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Registry task',
        requirements: ['FR-1'],
        commandIdempotencyKey: undefined,
      }),
      undefined
    );
    expect(createTask).not.toHaveBeenCalled();
  });

  it('stores artifact bytes locally under the verifier basename and keeps only metadata on the task', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-task-artifact-'));
    setAppDataBasePath(root);
    setClaudeBasePathOverride(root);
    try {
      const client = {
        requestTaskCompletionChallenge: vi.fn(),
        completeTask: vi.fn(),
        replayTaskCompletionRequest: vi.fn(),
        requestTaskPolicyChangeChallenge: vi.fn(),
        changeTaskPolicy: vi.fn(),
        replayTaskPolicyChangeRequest: vi.fn(),
      };
      const { service, writer } = makeService(
        {
          name: TEAM,
          specProject: PROJECT,
          specSlug: SPEC,
        },
        makeFakeWriter(),
        undefined,
        undefined,
        undefined,
        {
          registryTaskCompletionClientFactory: async () => client,
        }
      );
      const data = Buffer.from('local proof bytes');
      await service.updateTaskFields(TEAM, '1', {
        artifactRequired: true,
        artifactExpectedFilename: 'proof.pdf',
        artifactFile: { filename: 'proof.pdf', base64Data: data.toString('base64') },
      });

      const lastPatchCall = writer.applyExecutionPatch.mock.calls.at(-1);
      const executionPatch = lastPatchCall?.[1];
      if (!executionPatch) throw new Error('Expected execution patch');
      const rawAttachments: unknown = executionPatch.attachments;
      if (!Array.isArray(rawAttachments)) throw new Error('Expected attachment metadata');
      const rawAttachment: unknown = rawAttachments[0];
      if (
        !rawAttachment ||
        typeof rawAttachment !== 'object' ||
        Array.isArray(rawAttachment) ||
        !('id' in rawAttachment) ||
        typeof rawAttachment.id !== 'string' ||
        !('filename' in rawAttachment) ||
        typeof rawAttachment.filename !== 'string' ||
        !('filePath' in rawAttachment) ||
        typeof rawAttachment.filePath !== 'string' ||
        !('size' in rawAttachment) ||
        typeof rawAttachment.size !== 'number'
      ) {
        throw new Error('Invalid attachment metadata');
      }
      const attachment = {
        id: rawAttachment.id,
        filename: rawAttachment.filename,
        filePath: rawAttachment.filePath,
        size: rawAttachment.size,
      };
      expect(attachment).toMatchObject({ filename: 'proof.pdf', size: data.length });
      expect(attachment.filePath).toBe(
        path.join(root, 'data', 'task-attachments', TEAM, '1', `${attachment.id}--artifact.bin`)
      );
      expect(await fs.readFile(attachment.filePath)).toEqual(data);
      expect(executionPatch.artifactRequirement).toMatchObject({
        required: true,
        expectedFilename: 'proof.pdf',
        proof: {
          attachmentId: attachment.id,
          sha256: createHash('sha256').update(data).digest('hex'),
          size: data.length,
        },
      });
      expect(writer.updateCanonicalFields.mock.calls[0]?.[0]).not.toHaveProperty('artifactFile');
      expect(writer.updateCanonicalFields.mock.calls[0]?.[0]).not.toHaveProperty(
        'artifactRequired'
      );
      expect(writer.updateCanonicalFields.mock.calls[0]?.[0]).not.toHaveProperty(
        'artifactExpectedFilename'
      );
      expect(writer.updateCanonicalFields.mock.calls[0]?.[0]).not.toHaveProperty('attachments');
      expect(client.requestTaskPolicyChangeChallenge).not.toHaveBeenCalled();
      expect(client.changeTaskPolicy).not.toHaveBeenCalled();
      expect(writer.updateCanonicalFields.mock.calls[0]?.[0]).not.toHaveProperty('filePath');
    } finally {
      setAppDataBasePath(null);
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('uses a draft binding before launch but not when a config file exists and is unreadable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-draft-binding-'));
    const teamDir = path.join(root, 'teams', TEAM);
    setClaudeBasePathOverride(root);
    try {
      await fs.mkdir(teamDir, { recursive: true });
      const draftMetadata: TeamMetaFile = {
        version: 1,
        cwd: root,
        createdAt: 1,
        registryTeamId: 'registry-team-alpha',
        specProject: PROJECT,
        specSlug: SPEC,
      };
      await fs.writeFile(path.join(teamDir, 'team.meta.json'), JSON.stringify(draftMetadata));
      const { service, writer, provider } = makeService(
        null,
        makeFakeWriter(),
        undefined,
        undefined,
        undefined,
        { initialMetadata: draftMetadata }
      );
      const task = await service.createTask(TEAM, {
        specProject: PROJECT,
        specSlug: SPEC,
        subject: 'Draft task',
        requirements: ['FR-1'],
      });
      expect(provider).toHaveBeenCalledWith({
        teamName: TEAM,
        binding: { project: PROJECT, spec: SPEC },
      });
      expect(writer.createTask).toHaveBeenCalledOnce();

      await fs.writeFile(path.join(teamDir, 'config.json'), '{invalid');
      await expect(
        service.createTask(TEAM, {
          specProject: PROJECT,
          specSlug: SPEC,
          subject: 'Must not create',
          requirements: ['FR-1'],
        })
      ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_INCOMPLETE' });
      expect(writer.createTask).toHaveBeenCalledOnce();
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('exposes the creation outcome and forwards initial status and execution metadata', async () => {
    const { service, writer } = makeService({ name: TEAM, specProject: PROJECT, specSlug: SPEC });
    writer.createTask.mockResolvedValueOnce({
      task: { id: '1', subject: 'Registry task', status: 'completed' },
      createdInAttempt: false,
    });
    const result = await service.createTaskWithOutcome(
      TEAM,
      {
        specProject: PROJECT,
        specSlug: SPEC,
        subject: 'Registry task',
        requirements: ['FR-1'],
        status: 'completed',
      },
      { prompt: 'instructions' }
    );
    expect(result.outcome).toBe('REPLAY');
    expect(writer.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        executionPatch: { prompt: 'instructions' },
      }),
      undefined
    );
  });

  it('creates locally when an unbound team receives no registry scope', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });
    await expect(service.createTask(TEAM, { subject: 'Local task' })).resolves.toMatchObject({
      subject: 'Local task',
    });
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Local task' }));
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects local fallback when an unreadable config leaves task authority unknown', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-unknown-authority-'));
    setClaudeBasePathOverride(root);
    const { service, setTaskStatus, provider } = makeService(null);
    try {
      const teamDir = path.join(root, 'teams', TEAM);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.writeFile(path.join(teamDir, 'config.json'), '{invalid');

      await expect(service.updateTaskStatus(TEAM, '9', 'in_progress')).rejects.toMatchObject({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
      });
      expect(setTaskStatus).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('rejects partial registry scope without creating a local task', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });
    const partialRequest = {
      subject: 'Partial scope',
      specProject: PROJECT,
    } as unknown as CreateTaskRequest;
    await expect(service.createTask(TEAM, partialRequest)).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('does not fall back locally when an unbound team receives registry scope', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });
    await expect(
      service.createTask(TEAM, {
        subject: 'Unlinked registry scope',
        specProject: PROJECT,
        specSlug: SPEC,
        requirements: ['FR-1'],
      })
    ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_UNLINKED' });
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('requires registry scope for task creation on a bound team', async () => {
    const { service, createTask, provider } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });
    await expect(service.createTask(TEAM, { subject: 'Missing scope' })).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('uses the local task board only when status preconditions match', async () => {
    const { service, getTask, setTaskStatus, provider } = makeService({ name: TEAM });

    await expect(
      service.updateTaskStatusWithReceipt(TEAM, '9', 'in_progress', 'alice', 'pending')
    ).resolves.toEqual([]);
    expect(getTask).toHaveBeenCalledWith('9');
    expect(setTaskStatus).toHaveBeenCalledWith('9', 'in_progress', 'alice');
    expect(provider).not.toHaveBeenCalled();
  });

  it('writes local execution patches to the injected local store', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-local-execution-'));
    try {
      const executionTaskStore = new ExecutionTaskStore({ basePath: root });
      const { service, provider } = makeService(
        { name: TEAM },
        makeFakeWriter(),
        executionTaskStore
      );
      await service.applyTaskExecutionPatch(TEAM, 'task-1', { needsClarification: 'user' });
      expect(executionTaskStore.read(TEAM, 'task-1')).toMatchObject({
        needsClarification: 'user',
      });
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('serializes a registry execution patch with completion', async () => {
    const journal = new TaskAttestationJournal(path.join(testRoot!, 'teams'));
    const writer = makeFakeWriter();
    let notifyEntered!: () => void;
    let releasePatch!: () => void;
    const entered = new Promise<void>((resolve) => {
      notifyEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    writer.applyExecutionPatch.mockImplementationOnce(async () => {
      notifyEntered();
      await release;
    });
    const { service } = makeService(
      { name: TEAM, specProject: PROJECT, specSlug: SPEC },
      writer,
      undefined,
      undefined,
      undefined,
      { taskAttestationJournal: journal }
    );
    const patch = service.applyTaskExecutionPatch(TEAM, '1', { attachments: [] });
    await entered;
    const completion = service.updateTaskStatus(TEAM, '1', 'completed', 'alice');
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writer.replaceStatus).not.toHaveBeenCalled();
    } finally {
      releasePatch();
    }
    await patch;
    await completion;
    expect(writer.replaceStatus).toHaveBeenCalledWith({
      taskId: '1',
      to: 'completed',
      actor: 'alice',
      expectedStatus: 'pending',
    });
  });

  it('never falls back to local execution writes for a requested registry scope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-scoped-execution-'));
    try {
      const executionTaskStore = new ExecutionTaskStore({ basePath: root });
      const { service, provider } = makeService(
        { name: TEAM },
        makeFakeWriter(),
        executionTaskStore
      );
      await expect(
        service.applyTaskExecutionPatch(
          TEAM,
          'task-1',
          { needsClarification: 'user' },
          { project: PROJECT, spec: SPEC }
        )
      ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_UNLINKED' });
      expect(executionTaskStore.read(TEAM, 'task-1')).toBeNull();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  it('never falls back to a local field update for a requested registry scope', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });
    await expect(
      service.updateTaskFields(
        TEAM,
        '9',
        { subject: 'Unlinked write' },
        {
          project: PROJECT,
          spec: SPEC,
        }
      )
    ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_UNLINKED' });
    expect(createTask).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('never falls back to local relationship writes for a requested registry scope', async () => {
    const { service, linkTask, unlinkTask, provider } = makeService({ name: TEAM });
    const binding = { project: PROJECT, spec: SPEC };
    await expect(
      service.addTaskRelationship(TEAM, '9', '10', 'blockedBy', binding)
    ).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_UNLINKED',
    });
    await expect(
      service.removeTaskRelationship(TEAM, '9', '10', 'blockedBy', binding)
    ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_UNLINKED' });
    expect(linkTask).not.toHaveBeenCalled();
    expect(unlinkTask).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it('preserves a pending journal entry and fails closed without replaying another operation', async () => {
    const journal = new TaskAttestationJournal(path.join(testRoot!, 'teams'));
    const pending = makePendingPolicyEntry();
    await journal.run(TEAM, async (entries, save) => {
      entries.push(pending);
      save();
    });
    const client = {
      requestTaskCompletionChallenge: vi.fn(),
      completeTask: vi.fn(),
      replayTaskCompletionRequest: vi.fn(),
      requestTaskPolicyChangeChallenge: vi.fn(),
      changeTaskPolicy: vi.fn(),
      replayTaskPolicyChangeRequest: vi.fn(),
    };
    const { service, writer } = makeService(
      { name: TEAM, specProject: PROJECT, specSlug: SPEC },
      makeFakeWriter(),
      undefined,
      undefined,
      undefined,
      { registryTaskCompletionClientFactory: async () => client, taskAttestationJournal: journal }
    );
    await expect(service.updateTaskStatus(TEAM, '1', 'completed')).rejects.toMatchObject({
      code: 'TASK_SECURITY_OUTCOME_UNKNOWN',
    });
    await expect(
      service.updateTaskFields(TEAM, '1', { artifactRequired: false })
    ).rejects.toMatchObject({
      code: 'TASK_SECURITY_OUTCOME_UNKNOWN',
    });
    await expect(
      service.applyTaskExecutionPatch(TEAM, '1', { artifactRequirement: { required: false } })
    ).rejects.toMatchObject({ code: 'TASK_SECURITY_OUTCOME_UNKNOWN' });
    expect(writer.applyExecutionPatch).not.toHaveBeenCalled();
    expect(writer.replaceStatus).not.toHaveBeenCalled();
    expect(client.replayTaskPolicyChangeRequest).not.toHaveBeenCalled();
    await expect(journal.run(TEAM, async (entries) => entries)).resolves.toEqual([pending]);
  });

  it('fails closed and preserves a corrupt attestation journal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-attestation-corrupt-'));
    try {
      const journal = new TaskAttestationJournal(path.join(root, 'teams'));
      const file = path.join(root, 'teams', TEAM, '.task-attestations', 'journal.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const corrupt = '{"version":1,"entries":[{"operation":"policy"}]}';
      await fs.writeFile(file, corrupt, 'utf8');
      const operation = vi.fn(async () => 'must-not-run');

      await expect(journal.run(TEAM, operation)).rejects.toThrow(
        'Invalid task attestation journal'
      );
      expect(operation).not.toHaveBeenCalled();
      await expect(fs.readFile(file, 'utf8')).resolves.toBe(corrupt);
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});
