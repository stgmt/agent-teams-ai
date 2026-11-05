// @vitest-environment node
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
    (input: { taskId: string; to: string; actor?: string }) => Promise<WriterOutcome>
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
    replaceStatus: vi.fn(async () => 'APPLIED' as const),
    replaceOwner: vi.fn(async () => 'APPLIED' as const),
    createTask: vi.fn(async () => ({
      task: {
        id: '1',
        displayId: '#1',
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

describe('TeamDataService registry flag', () => {
  it('keeps the file-backed task board when the team has no spec binding', async () => {
    const { service, setTaskStatus, provider } = makeService({ name: TEAM });

    await service.updateTaskStatus(TEAM, '1', 'completed');

    expect(provider).not.toHaveBeenCalled();
    expect(setTaskStatus).toHaveBeenCalledWith('1', 'completed', undefined);
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
      })
    );
    expect(createTask).not.toHaveBeenCalled();
  });

  it('keeps the file-backed creation path when the team has no spec binding', async () => {
    const { service, createTask, provider } = makeService({ name: TEAM });

    const task = await service.createTask(TEAM, { subject: 'Legacy task' });

    expect(task.id).toBe('9');
    expect(provider).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
  });
});
