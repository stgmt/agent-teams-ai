import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamTaskRoutes } from '../teamTaskRoutes';

import type { HttpServices } from '../../index';
import type { TeamHttpDataApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamTask } from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

const currentTask = {
  id: 'TASK-1',
  displayId: '#TASK-1',
  subject: 'Submit evidence',
  status: 'pending',
} as TeamTask;

describe('team task artifact HTTP patch', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function start(api: Partial<TeamHttpDataApi>): FastifyInstance {
    app = Fastify();
    registerTeamTaskRoutes(app, { teamDataApi: api } as unknown as HttpServices);
    return app;
  }

  it('accepts the local artifact payload above Fastify’s default limit and forwards scope', async () => {
    const getTask = vi.fn().mockResolvedValue(currentTask);
    const updateTaskFields = vi.fn().mockResolvedValue(undefined);
    const api = { getTask, updateTaskFields };
    const base64Data = Buffer.alloc(800 * 1024).toString('base64');
    const response = await start(api).inject({
      method: 'PATCH',
      url: '/api/teams/demo-team/tasks/TASK-1?project=owner%2Fproject&spec=spec-a',
      payload: {
        artifactRequired: true,
        artifactExpectedFilename: 'proof.pdf',
        artifactFile: { filename: 'proof.pdf', base64Data },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(getTask).toHaveBeenNthCalledWith(1, 'demo-team', 'TASK-1', {
      project: 'owner/project',
      spec: 'spec-a',
    });
    expect(updateTaskFields).toHaveBeenCalledWith(
      'demo-team',
      'TASK-1',
      {
        artifactRequired: true,
        artifactExpectedFilename: 'proof.pdf',
        artifactFile: { filename: 'proof.pdf', base64Data },
      },
      { project: 'owner/project', spec: 'spec-a' }
    );
  });
  it('downloads verified app-owned artifact bytes by task and attachment ID only', async () => {
    const bytes = Buffer.from('stored artifact bytes');
    const base64Data = bytes.toString('base64');
    const attachmentId = '7c9cf906-80d1-4eab-a824-08324a99b317';
    const task = {
      ...currentTask,
      artifactRequirement: {
        required: true,
        proof: {
          attachmentId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        },
      },
      attachments: [
        {
          id: attachmentId,
          filename: 'proof.txt',
          mimeType: 'text/plain',
          size: bytes.length,
          addedAt: '2026-11-08T00:00:00.000Z',
          filePath: 'C:/must-not-be-returned/proof.txt',
        },
      ],
    } as TeamTask;
    const getTask = vi.fn().mockResolvedValue(task);
    const readTaskArtifactData = vi.fn().mockResolvedValue(base64Data);
    const response = await start({ getTask, readTaskArtifactData }).inject({
      method: 'GET',
      url: `/api/teams/demo-team/tasks/TASK-1/artifact/${attachmentId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(readTaskArtifactData).toHaveBeenCalledTimes(1);
    expect(readTaskArtifactData).toHaveBeenCalledWith('demo-team', 'TASK-1', attachmentId);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      filename: 'proof.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: task.artifactRequirement?.proof?.sha256,
      base64Data,
    });
    expect(response.json()).not.toHaveProperty('filePath');
  });

  it('rejects app-owned artifact bytes that do not match task proof metadata', async () => {
    const expected = Buffer.from('expected bytes');
    const altered = Buffer.from('expected bytez');
    const attachmentId = '7c9cf906-80d1-4eab-a824-08324a99b317';
    const task = {
      ...currentTask,
      artifactRequirement: {
        required: true,
        proof: {
          attachmentId,
          sha256: createHash('sha256').update(expected).digest('hex'),
          size: expected.length,
        },
      },
      attachments: [
        {
          id: attachmentId,
          filename: 'proof.txt',
          mimeType: 'text/plain',
          size: expected.length,
          addedAt: '2026-11-08T00:00:00.000Z',
        },
      ],
    } as TeamTask;
    const response = await start({
      getTask: vi.fn().mockResolvedValue(task),
      readTaskArtifactData: vi.fn().mockResolvedValue(altered.toString('base64')),
    }).inject({
      method: 'GET',
      url: `/api/teams/demo-team/tasks/TASK-1/artifact/${attachmentId}`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'ARTIFACT_UNVERIFIED' });
  });

  it('does not accept a path or MIME override on artifact reads', async () => {
    const getTask = vi.fn();
    const readTaskArtifactData = vi.fn();
    const app = start({ getTask, readTaskArtifactData });
    const response = await app.inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks/TASK-1/artifact/attachment-id?filePath=C%3A%2Fsecret&mimeType=text%2Fplain',
    });
    const bodyResponse = await app.inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks/TASK-1/artifact/attachment-id',
      payload: { filePath: 'C:/secret', base64Data: 'AA==' },
    });

    expect(response.statusCode).toBe(400);
    expect(bodyResponse.statusCode).toBe(400);
    expect(getTask).not.toHaveBeenCalled();
    expect(readTaskArtifactData).not.toHaveBeenCalled();
  });

  it('returns the agreed not-found envelope without reading missing artifact bytes', async () => {
    const getTask = vi.fn().mockResolvedValue(currentTask);
    const readTaskArtifactData = vi.fn();
    const response = await start({ getTask, readTaskArtifactData }).inject({
      method: 'GET',
      url: '/api/teams/demo-team/tasks/TASK-1/artifact/attachment-id',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'TASK_NOT_FOUND',
      error: 'Task artifact not found',
    });
    expect(readTaskArtifactData).not.toHaveBeenCalled();
  });

  it.each([
    ['path traversal', { filename: '../secret.txt', base64Data: 'AA==' }],
    ['non-canonical padding bits', { filename: 'proof.pdf', base64Data: 'AR==' }],
    ['unexpected local path', { filename: 'proof.pdf', base64Data: 'AA==', filePath: 'C:/secret' }],
  ])(
    'rejects an invalid artifact upload (%s) before task mutation',
    async (_label, artifactFile) => {
      const updateTaskFields = vi.fn().mockResolvedValue(undefined);
      const response = await start({
        getTask: vi.fn().mockResolvedValue(currentTask),
        updateTaskFields,
      }).inject({
        method: 'PATCH',
        url: '/api/teams/demo-team/tasks/TASK-1',
        payload: { artifactFile },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_TASK_FIELD' });
      expect(updateTaskFields).not.toHaveBeenCalled();
    }
  );
});
