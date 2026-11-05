import { RegistryTaskProviderError } from '@main/services/team/registry/RegistryTaskProvider';
import { RegistryTeamTaskWriteError } from '@main/services/team/registry/RegistryTeamTaskWriter';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamTaskRoutes } from '../teams/teamTaskRoutes';

import type { HttpServices } from '../index';
import type { TeamHttpDataApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamTask } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

function task(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: '7',
    displayId: '#7',
    subject: 'Wire the task routes',
    status: 'pending',
    ...overrides,
  };
}

function createTaskApi(overrides: Partial<TeamHttpDataApi> = {}): TeamHttpDataApi {
  return {
    listTeams: vi.fn(),
    getTeamData: vi.fn(),
    getSavedRequest: vi.fn(),
    createTeamConfig: vi.fn(),
    renameDraftTeam: vi.fn(),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(task()),
    createTask: vi.fn().mockResolvedValue(task()),
    createTaskWithOutcome: vi.fn().mockResolvedValue({ task: task(), outcome: 'APPLIED' }),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    updateTaskStatusWithReceipt: vi.fn().mockResolvedValue([]),
    updateTaskOwner: vi.fn().mockResolvedValue(undefined),
    updateTaskFields: vi.fn().mockResolvedValue(undefined),
    applyTaskExecutionPatch: vi.fn().mockResolvedValue(undefined),
    addTaskRelationship: vi.fn().mockResolvedValue(undefined),
    removeTaskRelationship: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TeamHttpDataApi;
}

describe('team task HTTP routes', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function start(api: TeamHttpDataApi): FastifyInstance {
    app = Fastify();
    registerTeamTaskRoutes(app, { teamDataApi: api } as unknown as HttpServices);
    return app;
  }

  /** The route logs 5xx failures; the global console guard must see them consumed. */
  function consumeLoggedError(fragment: string): void {
    const errorSpy = vi.mocked(console.error);
    expect(
      errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(fragment)))
    ).toBe(true);
    errorSpy.mockClear();
  }

  it('GET returns the team task list', async () => {
    const api = createTaskApi({ getTasks: vi.fn().mockResolvedValue([task()]) });
    const response = await start(api).inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tasks: [task()] });
    expect(api.getTasks).toHaveBeenCalledWith('demo-team');
  });

  it('GET rejects a non-exact team name', async () => {
    const api = createTaskApi();
    const response = await start(api).inject({
      method: 'GET',
      url: '/api/teams/%20demo-team%20/tasks',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_TEAM_NAME' });
    expect(api.getTasks).not.toHaveBeenCalled();
  });

  it('POST creates a task and normalizes requirements', async () => {
    const createTaskWithOutcome = vi.fn().mockResolvedValue({
      task: task({ owner: 'alice' }),
      outcome: 'APPLIED',
    });
    const response = await start(createTaskApi({ createTaskWithOutcome })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: {
        subject: '  Wire tasks  ',
        description: 'adapter only',
        requirements: [' FR-1 ', 'FR-1', 'AC-2'],
        owner: 'alice',
        activeForm: 'Wiring tasks',
        projectPath: 'E:/repos/demo',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ task: task({ owner: 'alice' }), outcome: 'APPLIED' });
    expect(createTaskWithOutcome).toHaveBeenCalledWith(
      'demo-team',
      {
        subject: 'Wire tasks',
        description: 'adapter only',
        requirements: ['FR-1', 'AC-2'],
        owner: 'alice',
      },
      { activeForm: 'Wiring tasks', projectPath: 'E:/repos/demo' }
    );
  });

  it('returns a replayed task without treating it as a new creation', async () => {
    const existing = task({ status: 'completed' });
    const response = await start(
      createTaskApi({
        createTaskWithOutcome: vi.fn().mockResolvedValue({ task: existing, outcome: 'REPLAY' }),
      })
    ).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'Already created', requirements: ['FR-1'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ task: existing, outcome: 'REPLAY' });
  });

  it('rejects invalid execution metadata before creating a canonical task', async () => {
    const api = createTaskApi();
    const response = await start(api).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'Task', requirements: ['FR-1'], comments: 'not-an-array' },
    });
    expect(response.statusCode).toBe(400);
    expect(api.createTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('POST without requirements answers 400 REQUIREMENTS_REQUIRED', async () => {
    const api = createTaskApi();
    const response = await start(api).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'No requirements' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'REQUIREMENTS_REQUIRED' });
    expect(api.createTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('POST rejects an empty requirements array', async () => {
    const api = createTaskApi();
    const response = await start(api).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'Empty requirements', requirements: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'REQUIREMENTS_REQUIRED' });
    expect(api.createTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('POST rejects malformed bodies and field types', async () => {
    const api = createTaskApi();
    const instance = start(api);

    const notAnObject = await instance.inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: [1, 2, 3],
    });
    expect(notAnObject.statusCode).toBe(400);
    expect(notAnObject.json()).toMatchObject({ code: 'INVALID_TASK_BODY' });

    const wrongRequirements = await instance.inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'Task', requirements: 'FR-1' },
    });
    expect(wrongRequirements.statusCode).toBe(400);
    expect(wrongRequirements.json()).toMatchObject({ code: 'INVALID_TASK_FIELD' });

    const wrongSubject = await instance.inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 42, requirements: ['FR-1'] },
    });
    expect(wrongSubject.statusCode).toBe(400);
    expect(wrongSubject.json()).toMatchObject({ code: 'INVALID_TASK_FIELD' });

    const tooLarge = await instance.inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'x'.repeat(501), requirements: ['FR-1'] },
    });
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json()).toMatchObject({ code: 'INVALID_TASK_FIELD' });

    expect(api.createTaskWithOutcome).not.toHaveBeenCalled();
  });

  it('POST maps a writer REQUIREMENTS_REQUIRED refusal to 400', async () => {
    const createTaskWithOutcome = vi
      .fn()
      .mockRejectedValue(
        new RegistryTeamTaskWriteError('REQUIREMENTS_REQUIRED', 'Requirements are required')
      );
    const response = await start(createTaskApi({ createTaskWithOutcome })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks',
      payload: { subject: 'Task', requirements: ['FR-1'] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'REQUIREMENTS_REQUIRED',
      message: 'Requirements are required',
    });
  });

  it('POST status returns the registry transition receipt and refreshed task', async () => {
    const updated = task({ status: 'in_progress' });
    const transitions = [
      {
        from: 'todo',
        to: 'in-progress',
        actor: 'alice',
        at: '2026-11-05T10:00:00Z',
        requestId: 'request-1',
        localId: 'TASK-7',
      },
    ];
    const updateTaskStatusWithReceipt = vi.fn().mockResolvedValue(transitions);
    const response = await start(
      createTaskApi({
        getTask: vi.fn().mockResolvedValue(updated),
        updateTaskStatusWithReceipt,
      })
    ).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'in_progress', expectedStatus: 'pending', actor: 'alice' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ task: updated, transitions });
    expect(updateTaskStatusWithReceipt).toHaveBeenCalledWith(
      'demo-team',
      '7',
      'in_progress',
      'alice',
      'pending'
    );
  });

  it('status answers 409 STATUS_CONFLICT with the registry current status', async () => {
    const updateTaskStatusWithReceipt = vi.fn().mockRejectedValue(
      new RegistryTeamTaskWriteError('STATUS_CONFLICT', 'Task changed in the spec registry', {
        taskId: '7',
        details: { currentStatus: 'done', expectedStatus: 'in-progress' },
      })
    );
    const response = await start(createTaskApi({ updateTaskStatusWithReceipt })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'in_progress' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'STATUS_CONFLICT',
      message: 'Task changed in the spec registry',
      currentStatus: 'done',
    });
  });

  it('passes the stale status precondition to the authoritative writer', async () => {
    const updateTaskStatusWithReceipt = vi.fn().mockRejectedValue(
      new RegistryTeamTaskWriteError('STATUS_CONFLICT', 'Task changed', {
        taskId: '7',
        details: { currentStatus: 'completed' },
      })
    );
    const response = await start(createTaskApi({ updateTaskStatusWithReceipt })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'in_progress', expectedStatus: 'pending' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'STATUS_CONFLICT', currentStatus: 'completed' });
    expect(updateTaskStatusWithReceipt).toHaveBeenCalledWith(
      'demo-team',
      '7',
      'in_progress',
      undefined,
      'pending'
    );
  });

  it('status rejects a status outside the writable registry vocabulary', async () => {
    const updateTaskStatusWithReceipt = vi.fn();
    const response = await start(createTaskApi({ updateTaskStatusWithReceipt })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'archived' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_TASK_STATUS' });
    expect(updateTaskStatusWithReceipt).not.toHaveBeenCalled();
  });

  it('status answers 404 when the task vanished', async () => {
    const api = createTaskApi({
      updateTaskStatusWithReceipt: vi
        .fn()
        .mockRejectedValue(new RegistryTeamTaskWriteError('TASK_NOT_FOUND', 'Task was removed')),
    });
    const response = await start(api).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'in_progress', expectedStatus: 'pending' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(api.getTask).not.toHaveBeenCalled();
  });

  it('PATCH applies owner, fields and a diffed relationship set', async () => {
    const current = task({ blockedBy: ['1', '2'], related: ['3'] });
    const updated = task({ owner: 'bob', subject: 'Renamed', blockedBy: ['2', '4'] });
    const getTask = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
    const updateTaskOwner = vi.fn().mockResolvedValue(undefined);
    const updateTaskFields = vi.fn().mockResolvedValue(undefined);
    const addTaskRelationship = vi.fn().mockResolvedValue(undefined);
    const removeTaskRelationship = vi.fn().mockResolvedValue(undefined);

    const response = await start(
      createTaskApi({
        getTask,
        updateTaskOwner,
        updateTaskFields,
        addTaskRelationship,
        removeTaskRelationship,
      })
    ).inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/7',
      payload: { owner: 'bob', subject: 'Renamed', blockedBy: ['2', '4'], related: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ task: updated });
    expect(updateTaskOwner).toHaveBeenCalledWith('demo-team', '7', 'bob', undefined);
    expect(updateTaskFields).toHaveBeenCalledWith('demo-team', '7', { subject: 'Renamed' });
    expect(removeTaskRelationship).toHaveBeenCalledWith('demo-team', '7', '1', 'blockedBy');
    expect(addTaskRelationship).toHaveBeenCalledWith('demo-team', '7', '4', 'blockedBy');
    expect(removeTaskRelationship).toHaveBeenCalledWith('demo-team', '7', '3', 'related');
  });

  it('rejects malformed execution metadata before applying canonical updates', async () => {
    const api = createTaskApi();
    const response = await start(api).inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/7',
      payload: { subject: 'Must not be written', workIntervals: 'invalid' },
    });
    expect(response.statusCode).toBe(400);
    expect(api.updateTaskFields).not.toHaveBeenCalled();
  });

  it('PATCH rejects an empty patch and an unknown task', async () => {
    const api = createTaskApi({ getTask: vi.fn().mockResolvedValue(null) });
    const instance = start(api);

    const empty = await instance.inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/7',
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'INVALID_TASK_BODY' });

    const missing = await instance.inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/9',
      payload: { owner: 'bob' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'TASK_NOT_FOUND' });
  });

  it('maps an unavailable registry to 503 without leaking internals', async () => {
    const getTasks = vi.fn().mockRejectedValue(
      new RegistryTaskProviderError({
        code: 'REGISTRY_UNAVAILABLE',
        teamName: 'demo-team',
        message: 'Spec registry is unavailable (token=registry-secret)',
        project: 'demo',
        spec: 'demo-spec',
        causeCode: 'TRANSPORT_ERROR',
      })
    );
    const response = await start(createTaskApi({ getTasks })).inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: 'REGISTRY_UNAVAILABLE',
      message: 'The spec registry is unavailable; no task state could be read',
    });
    expect(response.body).not.toContain('registry-secret');
    consumeLoggedError('The spec registry is unavailable');
  });

  it('maps an unconfirmed registry write to 503', async () => {
    const updateTaskStatusWithReceipt = vi.fn().mockRejectedValue(
      new RegistryTeamTaskWriteError('REGISTRY_REFUSED', 'The spec registry did not confirm', {
        taskId: '7',
        details: { clientCode: 'TIMEOUT', retryable: true },
      })
    );
    const response = await start(createTaskApi({ updateTaskStatusWithReceipt })).inject({
      method: 'POST',
      url: '/api/teams/demo-team/tasks/7/status',
      payload: { status: 'completed' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'REGISTRY_UNAVAILABLE' });
    consumeLoggedError('The spec registry is unavailable');
  });

  it('maps TASK_NOT_FOUND from the writer to 404', async () => {
    const updateTaskOwner = vi
      .fn()
      .mockRejectedValue(new RegistryTeamTaskWriteError('TASK_NOT_FOUND', 'Unknown task'));
    const response = await start(createTaskApi({ updateTaskOwner })).inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/7',
      payload: { owner: 'bob' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'TASK_NOT_FOUND', message: 'Unknown task' });
  });

  it('keeps unexpected failures opaque', async () => {
    const getTasks = vi.fn().mockRejectedValue(new Error('unexpected internal failure'));
    const response = await start(createTaskApi({ getTasks })).inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    consumeLoggedError('unexpected internal failure');
  });
});
