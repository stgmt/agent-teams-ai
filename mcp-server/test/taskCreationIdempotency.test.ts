import { describe, expect, it, vi } from 'vitest';

import {
  createTaskWithOptionalIdempotency,
  resolveMessageTaskCommandId,
  resolveOptionalTaskCreateCommandId,
} from '../src/utils/taskCreationIdempotency';

describe('task creation idempotency', () => {
  it('keeps command UUIDs stable and derives UUIDs for opaque keys', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const uuidV7 = '019cce7c-f940-7777-8777-777777777777';
    const numericId = '12345678';

    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha', commandId: uuid })).toBe(uuid);
    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha', idempotencyKey: uuid })).toBe(
      uuid
    );
    expect(() =>
      resolveOptionalTaskCreateCommandId({ teamName: 'alpha', commandId: numericId })
    ).toThrow('task_create commandId must be a UUID (version 1-5)');
    expect(resolveOptionalTaskCreateCommandId({ teamName: 'alpha', idempotencyKey: numericId }))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(() =>
      resolveOptionalTaskCreateCommandId({ teamName: 'alpha', commandId: uuidV7 })
    ).toThrow('task_create commandId must be a UUID (version 1-5)');
    expect(
      resolveOptionalTaskCreateCommandId({ teamName: 'alpha', idempotencyKey: uuidV7 })
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('uses message id and request key as the task discriminator', () => {
    const first = resolveMessageTaskCommandId({
      teamName: 'alpha',
      messageId: 'msg-1',
      requestKey: 'login-task',
    });
    expect(first).toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-1',
        requestKey: 'login-task',
      })
    );
    expect(first).not.toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-1',
        requestKey: 'api-task',
      })
    );
    expect(first).not.toBe(
      resolveMessageTaskCommandId({
        teamName: 'alpha',
        messageId: 'msg-2',
        requestKey: 'login-task',
      })
    );
  });

  it('reconciles before mutable admission and propagates reconciliation conflicts', () => {
    const commandId = '11111111-1111-4111-8111-111111111111';
    const createTask = vi.fn();
    const reconcileTaskCreation = vi.fn(() => ({ id: '7' }));
    const admitCreate = vi.fn(async () => {});
    const taskBoard = { createTask, reconcileTaskCreation };
    const input = {
      taskBoard, teamName: 'alpha', operation: 'task.create' as const,
      payload: { subject: 'Stable task' }, commandId, admitCreate,
    };
    expect(createTaskWithOptionalIdempotency(input)).toEqual({ id: '7' });
    expect(reconcileTaskCreation).toHaveBeenCalledWith(expect.objectContaining({
      creationCommand: expect.objectContaining({ commandId, payloadHash: expect.stringMatching(/^sha256:/) }),
    }));
    expect(admitCreate).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    reconcileTaskCreation.mockImplementationOnce(() => { throw new Error('Task creation command conflict'); });
    expect(() => createTaskWithOptionalIdempotency(input)).toThrow('Task creation command conflict');
  });

  it('admits a new command only when reconciliation reports not found', async () => {
    const createTask = vi.fn(() => ({ id: '8' }));
    const reconcileTaskCreation = vi.fn(() => { throw Object.assign(new Error('Not found'), { code: 'TASK_NOT_FOUND' }); });
    const admitCreate = vi.fn(async () => {});
    const result = await createTaskWithOptionalIdempotency({
      taskBoard: { createTask, reconcileTaskCreation }, teamName: 'alpha',
      operation: 'task.create', payload: { subject: 'New task' },
      commandId: '11111111-1111-4111-8111-111111111111', admitCreate,
    });
    expect(result).toEqual({ id: '8' });
    expect(admitCreate).toHaveBeenCalledOnce();
    expect(createTask).toHaveBeenCalledOnce();
  });
});