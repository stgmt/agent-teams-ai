import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type TaskPolicy, taskPolicyDigest } from '@main/services/identity/TaskAttestation';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { knownEmptyTeamRuntimeSnapshot } from '../../../../../../test/helpers/teamRuntimeSnapshot';
import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import {
  TaskAttestationJournal,
  type TaskAttestationJournalEntry,
} from '../../execution/TaskAttestationJournal';
import { TeamDataService } from '../../TeamDataService';
import { TeamTaskAttachmentStore } from '../../TeamTaskAttachmentStore';
import { RegistryTaskProvider } from '../RegistryTaskProvider';
import { resolveTeamSpecScope, TeamSpecBindingError } from '../TeamSpecBinding';

import type { TeamMetaFile } from '../../TeamMetaStore';
import type { RegistryTaskClient } from '../RegistryTaskClient';
import type { RegistryTaskPolicyChangeReplayRecord } from '../RegistryTaskClientTypes';
import type { RegistryTeamTaskWriter } from '../RegistryTeamTaskWriter';
import type { DesktopSigningKeyStore } from '@main/services/identity/DesktopSigningKeyStore';
import type { CreateTaskRequest, TeamConfig, TeamSpecScope, TeamTask } from '@shared/types';
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
  const linkedBindings = currentConfig?.specScope?.bindings.some(
    (binding) => binding.project === PROJECT && binding.spec === SPEC
  )
    ? [registryBinding]
    : [];
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
    updateSpecScope: async (teamName: string, scope: TeamSpecScope) => {
      if (!currentConfig) return null;
      currentConfig = {
        ...currentConfig,
        specScope: resolveTeamSpecScope({ specScope: scope }, teamName),
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
            specScope: currentConfig?.specScope,
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
  const registryTaskProvider = new RegistryTaskProvider({
    readConfig: async () => currentConfig,
  });
  vi.spyOn(registryTaskProvider, 'getTask').mockImplementation(async () => ({
    backed: true as const,
    task: registryTask,
  }));
  vi.spyOn(registryTaskProvider, 'getTaskScope').mockImplementation(
    async () => currentConfig?.specScope?.bindings[0] ?? null
  );
  const service = new TeamDataService(
    knownEmptyTeamRuntimeSnapshot,
    configReader as never,
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
    registryTaskProvider,
    executionTaskStore,
    taskAttachmentStore,
    options.taskSigningKeyStoreFactory,
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

  it.each([
    'create',
    'status',
    'status-receipt',
    'owner',
    'fields',
    'review',
    'start',
    'user-start',
    'delete',
    'restore',
    'link',
    'unlink',
    'comment',
  ] as const)(
    'refuses %s without registry scope and leaves local canonical files unchanged',
    async (operation) => {
      const teamDir = path.join(testRoot!, 'teams', TEAM);
      const tasksDir = path.join(testRoot!, 'tasks', TEAM);
      await fs.mkdir(teamDir, { recursive: true });
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          name: TEAM,
          members: [],
        })
      );
      const original = JSON.stringify({
        id: '9',
        subject: 'Local canonical task',
        status: 'pending',
        owner: 'alice',
        description: 'Must not be rewritten',
        blockedBy: [],
        related: [],
        comments: [],
        reviewState: 'none',
      });
      const taskFile = path.join(tasksDir, '9.json');
      await fs.writeFile(taskFile, original, 'utf8');
      const service = new TeamDataService(knownEmptyTeamRuntimeSnapshot);
      const writes = {
        create: () => service.createTask(TEAM, { subject: 'Unauthorized create' }),
        status: () => service.updateTaskStatus(TEAM, '9', 'completed', 'alice'),
        'status-receipt': () =>
          service.updateTaskStatusWithReceipt(TEAM, '9', 'in_progress', 'alice', 'pending'),
        owner: () => service.updateTaskOwner(TEAM, '9', 'bob'),
        fields: () => service.updateTaskFields(TEAM, '9', { subject: 'Unauthorized update' }),
        review: () => service.updateKanban(TEAM, '9', { op: 'set_column', column: 'review' }),
        start: () => service.startTask(TEAM, '9'),
        'user-start': () => service.startTaskByUser(TEAM, '9'),
        delete: () => service.softDeleteTask(TEAM, '9'),
        restore: () => service.restoreTask(TEAM, '9'),
        link: () => service.addTaskRelationship(TEAM, '9', '10', 'related'),
        unlink: () => service.removeTaskRelationship(TEAM, '9', '10', 'related'),
        comment: () => service.addTaskComment(TEAM, '9', 'Unauthorized comment'),
      };

      await expect(writes[operation]()).rejects.toMatchObject({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
      });
      expect(await fs.readFile(taskFile, 'utf8')).toBe(original);
      expect(await fs.readdir(tasksDir)).toEqual(['9.json']);
    }
  );

  it('refuses missing scope before consulting the attestation journal', async () => {
    const journal = new TaskAttestationJournal(path.join(testRoot!, 'teams'));
    const run = vi.spyOn(journal, 'run').mockRejectedValue(new Error('journal unavailable'));
    const { service } = makeService(
      { name: TEAM },
      makeFakeWriter(),
      undefined,
      undefined,
      undefined,
      { taskAttestationJournal: journal }
    );
    await expect(service.updateTaskStatus(TEAM, '9', 'in_progress', 'alice')).rejects.toMatchObject(
      {
        code: 'REGISTRY_SCOPE_INCOMPLETE',
      }
    );
    await expect(service.updateTaskStatus(TEAM, '9', 'completed', 'alice')).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    await expect(
      service.updateTaskStatusWithReceipt(TEAM, '9', 'completed', 'alice', 'pending')
    ).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_INCOMPLETE' });
    await expect(
      service.updateTaskFields(TEAM, '9', { subject: 'Local change' })
    ).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects direct desktop completion when the required proof is missing', async () => {
    const { service, writer } = makeService(
      {
        name: TEAM,
        specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
      },
      makeFakeWriter(),
      undefined,
      { required: true, expectedFilename: 'proof.pdf' }
    );
    await expect(service.updateTaskStatus(TEAM, '1', 'completed', 'alice')).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
    expect(writer.replaceStatus).not.toHaveBeenCalled();
  });

  it('keeps ordinary bound status changes on the registry status writer', async () => {
    const { service, setTaskStatus, writer } = makeService({
      name: TEAM,
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
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
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
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
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
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

  it('fails closed when a team scope contains an incomplete binding', async () => {
    const { service, setTaskStatus } = makeService({
      name: TEAM,
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: '' }] },
    });

    await expect(service.updateTaskStatus(TEAM, '1', 'completed')).rejects.toBeInstanceOf(
      TeamSpecBindingError
    );
    expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it('creates tasks through the registry writer when bound', async () => {
    const { service, createTask, writer } = makeService({
      name: TEAM,
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
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
        specScope: {
          projects: [PROJECT],
          bindings: [{ project: PROJECT, spec: SPEC }],
        },
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
    const { service, writer } = makeService({
      name: TEAM,
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
    });
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
      specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
    });
    await expect(service.createTask(TEAM, { subject: 'Missing scope' })).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
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
      {
        name: TEAM,
        specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
      },
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
