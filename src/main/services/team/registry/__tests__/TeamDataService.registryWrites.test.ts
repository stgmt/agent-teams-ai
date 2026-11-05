// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../TeamDataService';
import { TeamSpecBindingError } from '../TeamSpecBinding';

import type { RegistryTeamTaskWriter } from '../RegistryTeamTaskWriter';
import type { TeamConfig, TeamTask } from '@shared/types';
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
    binding: { project: PROJECT, spec: SPEC },
  };
}

function makeService(config: TeamConfig | null, writer: FakeWriter = makeFakeWriter()) {
  const setTaskStatus = vi.fn();
  const createTask = vi.fn(
    async (input: Record<string, unknown>) =>
      ({ id: '9', subject: String(input.subject), status: 'pending' }) as TeamTask
  );
  const controllerFactory = (() =>
    ({
      taskBoard: { setTaskStatus, createTask },
    }) as unknown as AgentTeamsController) as (teamName: string) => AgentTeamsController;
  const configReader = {
    getConfigSnapshot: async () => config,
    getConfig: async () => config,
  };
  const provider = vi.fn(async () => writer as unknown as RegistryTeamTaskWriter);
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
    controllerFactory,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    provider
  );
  return { service, setTaskStatus, createTask, provider, writer };
}

describe('TeamDataService required registry binding', () => {
  it('rejects status writes when the team has no spec binding', async () => {
    const { service, setTaskStatus, provider } = makeService({ name: TEAM });
    await expect(service.updateTaskStatus(TEAM, '1', 'completed')).rejects.toMatchObject({
      code: 'SPEC_PROJECT_MISSING',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it('routes status writes to the registry writer when the team is bound', async () => {
    const { service, setTaskStatus, writer } = makeService({
      name: TEAM,
      specProject: PROJECT,
      specSlug: SPEC,
    });

    await service.updateTaskStatus(TEAM, '1', 'completed', 'alice');

    expect(writer.replaceStatus).toHaveBeenCalledWith({
      taskId: '1',
      to: 'completed',
      actor: 'alice',
    });
    expect(setTaskStatus).not.toHaveBeenCalled();
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
      await fs.writeFile(
        path.join(teamDir, 'team.meta.json'),
        JSON.stringify({ version: 1, cwd: root, specProject: PROJECT, specSlug: SPEC })
      );
      const { service, writer, provider } = makeService(null);
      const task = await service.createTask(TEAM, {
        subject: 'Draft task',
        requirements: ['FR-1'],
      });
      expect(task.id).toBe('1');
      expect(provider).toHaveBeenCalledWith({
        teamName: TEAM,
        binding: { project: PROJECT, spec: SPEC },
      });
      expect(writer.createTask).toHaveBeenCalledOnce();

      await fs.writeFile(path.join(teamDir, 'config.json'), '{invalid');
      await expect(
        service.createTask(TEAM, { subject: 'Must not create', requirements: ['FR-1'] })
      ).rejects.toMatchObject({ code: 'SPEC_PROJECT_MISSING' });
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
      { subject: 'Registry task', requirements: ['FR-1'], status: 'completed' },
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

  it('rejects creation when the team has no spec binding', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });
    await expect(service.createTask(TEAM, { subject: 'Unbound task' })).rejects.toMatchObject({
      code: 'SPEC_PROJECT_MISSING',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });
});
