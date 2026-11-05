import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export type StdioAppControlTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type StdioAppControlContext = {
  appInstanceId: string;
  dataRootFingerprint: string;
  connectionGeneration: number;
};
export type StdioAppControlTask = Record<string, unknown> & {
  id: string;
  displayId: string;
  subject: string;
  status: StdioAppControlTaskStatus;
  historyEvents?: Array<Record<string, unknown>>;
  comments?: Array<Record<string, unknown>>;
};
type FixtureTask = StdioAppControlTask;
export type StdioAppControlRequest = {
  method: string;
  url: string;
  body: unknown;
  appContext: string | undefined;
};
export type StdioAppControlGroupChat = { id: string; archivedAt: string | null };
export type StdioAppControlFixture = {
  baseUrl: string;
  context: StdioAppControlContext;
  requests: StdioAppControlRequest[];
  setGroupChats(teamName: string, chats: StdioAppControlGroupChat[]): void;
  seedTask(teamName: string, task: Record<string, unknown> & { id: string; subject: string }): void;
  updateTask(teamName: string, taskId: string, patch: Record<string, unknown>): void;
  getTask(teamName: string, taskId: string): StdioAppControlTask | undefined;
  close(): Promise<void>;
};
const VALID_REQUIREMENT_IDS: Record<string, true> = {
  'AC-1': true,
  'FR-1': true,
  'NFR-1': true,
};
const TIMESTAMP_EPOCH = Date.UTC(2026, 0, 1);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesContext(candidate: unknown, expected: StdioAppControlContext): boolean {
  return (
    isRecord(candidate) &&
    candidate.appInstanceId === expected.appInstanceId &&
    candidate.dataRootFingerprint === expected.dataRootFingerprint &&
    candidate.connectionGeneration === expected.connectionGeneration
  );
}

export async function startStdioAppControlFixture(
  options: { claudeDir: string; context?: StdioAppControlContext }
): Promise<StdioAppControlFixture> {
  if (!isAbsolute(options.claudeDir)) {
    throw new Error('The app-control fixture requires an isolated absolute Claude directory');
  }
  const context = options.context ?? {
    appInstanceId: `stdio-e2e-${randomUUID()}`,
    dataRootFingerprint: `stdio-e2e-${randomUUID()}`,
    connectionGeneration: 1,
  };
  const requests: StdioAppControlRequest[] = [];
  const teamTasks = new Map<string, Map<string, FixtureTask>>();
  const groupChats = new Map<string, StdioAppControlGroupChat[]>();

  const getTeamTasks = (teamName: string) => {
    let tasks = teamTasks.get(teamName);
    if (!tasks) {
      tasks = new Map();
      teamTasks.set(teamName, tasks);
    }
    return tasks;
  };

  const snapshotTasks = (teamName: string) => {
    const tasks = [...getTeamTasks(teamName).values()];
    return tasks.map((task) => ({
      ...clone(task),
      blocks: tasks.filter((candidate) =>
        Array.isArray(candidate.blockedBy) && candidate.blockedBy.includes(task.id)
      ).map((candidate) => candidate.id),
    }));
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        sendJson(response, 400, {
          code: 'INVALID_JSON',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const method = request.method ?? 'GET';
      const url = request.url ?? '/';
      const appContext = request.headers['x-agent-teams-app-context'];
      requests.push({
        method,
        url,
        body: clone(body),
        appContext: Array.isArray(appContext) ? appContext[0] : appContext,
      });

      let suppliedContext: unknown;
      try {
        suppliedContext = typeof appContext === 'string' ? JSON.parse(appContext) : undefined;
      } catch {
        suppliedContext = undefined;
      }
      if (!matchesContext(suppliedContext, context)) {
        sendJson(response, 409, { code: 'APP_CONTEXT_MISMATCH', message: 'App context mismatch' });
        return;
      }

      if (method === 'GET' && url === '/api/app/connection') {
        sendJson(response, 200, { schemaVersion: 1, context });
        return;
      }

      const diagnosticsMatch = /^\/api\/teams\/([^/]+)\/members\/diagnostics(?:\?.*)?$/.exec(url);
      if (method === 'GET' && diagnosticsMatch) {
        const teamName = decodeURIComponent(diagnosticsMatch[1]);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(teamName)) {
          sendJson(response, 400, { code: 'INVALID_TEAM_NAME', message: 'Invalid team name' });
          return;
        }
        let teamConfig: unknown;
        try {
          teamConfig = JSON.parse(
            await readFile(join(options.claudeDir, 'teams', teamName, 'config.json'), 'utf8')
          );
        } catch {
          sendJson(response, 404, {
            code: 'TEAM_NOT_FOUND',
            message: `Team "${teamName}" diagnostics are unavailable`,
          });
          return;
        }
        const configuredMembers =
          isRecord(teamConfig) && Array.isArray(teamConfig.members) ? teamConfig.members : [];
        const members = configuredMembers.flatMap((member) => {
          if (!isRecord(member) || typeof member.name !== 'string' || !member.name.trim()) {
            return [];
          }
          return [{
            memberName: member.name.trim(),
            isLead: member.agentType === 'team-lead' || member.role === 'team-lead',
            diagnostics: [],
            alive: true,
            runtimeAlive: true,
            launchState: 'confirmed_alive',
            bootstrapConfirmed: true,
          }];
        });
        sendJson(response, 200, {
          teamName,
          generatedAt: new Date(TIMESTAMP_EPOCH).toISOString(),
          runId: `stdio-e2e-${teamName}`,
          members,
        });
        return;
      }

      const groupMatch = /^\/api\/teams\/([^/]+)\/group-chats\/list(?:\?.*)?$/.exec(url);
      if (method === 'POST' && groupMatch) {
        const teamName = decodeURIComponent(groupMatch[1]);
        const listRequest = isRecord(body) ? body : {};
        if (typeof listRequest.from !== 'string' || !listRequest.from.trim()) {
          sendJson(response, 400, { error: 'from must be a configured teammate name' });
          return;
        }
        sendJson(response, 200, clone(groupChats.get(teamName) ?? []));
        return;
      }

      const taskMatch = /^\/api\/teams\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(status))?)?(?:\?.*)?$/.exec(url);
      if (!taskMatch) {
        sendJson(response, 404, { code: 'NOT_FOUND', message: `Unhandled ${method} ${url}` });
        return;
      }

      const teamName = decodeURIComponent(taskMatch[1]);
      const taskId = taskMatch[2] ? decodeURIComponent(taskMatch[2]) : undefined;
      const isStatusRoute = taskMatch[3] === 'status';
      const tasks = getTeamTasks(teamName);
      const taskUrl = new URL(url, 'http://127.0.0.1');

      if (method === 'GET' && taskId === undefined) {
        const allTasks = snapshotTasks(teamName);
        const listedTasks = taskUrl.searchParams.get('includeDeleted') === 'true'
          ? allTasks
          : allTasks.filter((task) => task.status !== 'deleted');
        sendJson(response, 200, { tasks: listedTasks });
        return;
      }

      if (method === 'POST' && taskId === undefined) {
        if (!isRecord(body) || typeof body.subject !== 'string' || !body.subject.trim()) {
          sendJson(response, 400, { code: 'INVALID_TASK', message: 'Task subject is required' });
          return;
        }
        const requirements = body.requirements;
        if (
          !Array.isArray(requirements) ||
          requirements.length === 0 ||
          requirements.some((id) => typeof id !== 'string' || !Object.hasOwn(VALID_REQUIREMENT_IDS, id))
        ) {
          sendJson(response, 400, {
            code: 'REQUIREMENTS_REQUIRED',
            message: 'Tasks must name valid FR/NFR/AC requirement ids.',
          });
          return;
        }
        for (const field of ['blockedBy', 'related'] as const) {
          const linkedIds = body[field];
          if (linkedIds !== undefined && (!Array.isArray(linkedIds) || linkedIds.some((id) => !tasks.has(String(id))))) {
            sendJson(response, 404, { code: 'TASK_NOT_FOUND', message: `Invalid ${field} task link` });
            return;
          }
        }
        const id = String(Math.max(0, ...[...tasks.keys()].map(Number)) + 1);
        const timestamp = new Date(TIMESTAMP_EPOCH + Number(id) * 1000).toISOString();
        const status = (body.status === 'in_progress' ? 'in_progress' : 'pending') as StdioAppControlTaskStatus;
        const task = {
          id,
          displayId: id,
          subject: body.subject.trim(),
          status,
          requirements: [...new Set(requirements as string[])],
          createdAt: timestamp,
          updatedAt: timestamp,
          reviewState: 'none',
          comments: [],
          historyEvents: [{ type: 'task_created', status, timestamp }],
          blockedBy: Array.isArray(body.blockedBy) ? [...body.blockedBy] : [],
          related: Array.isArray(body.related) ? [...body.related] : [],
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.owner === 'string' && body.owner.trim() ? { owner: body.owner.trim() } : {}),
          ...(typeof body.groupChatId === 'string' ? { groupChatId: body.groupChatId } : {}),
          ...Object.fromEntries(Object.entries(body).filter(([key]) => [
            'createdBy', 'from', 'prompt', 'descriptionTaskRefs', 'promptTaskRefs', 'creationCommand',
          ].includes(key))),
        } as FixtureTask;
        tasks.set(id, task);
        sendJson(response, 201, { task: clone(task), outcome: 'APPLIED' });
        return;
      }

      if (!taskId || !tasks.has(taskId)) {
        sendJson(response, 404, { code: 'TASK_NOT_FOUND', message: `Task "${taskId ?? ''}" was not found` });
        return;
      }
      const task = tasks.get(taskId)!;

      if (method === 'POST' && isStatusRoute) {
        if (!isRecord(body) || !['pending', 'in_progress', 'completed', 'deleted'].includes(String(body.status))) {
          sendJson(response, 400, { code: 'INVALID_STATUS', message: 'Invalid task status' });
          return;
        }
        if (body.expectedStatus !== undefined && body.expectedStatus !== task.status) {
          sendJson(response, 409, {
            code: 'TASK_STATUS_CONFLICT',
            message: `Expected ${String(body.expectedStatus)} but task is ${task.status}`,
          });
          return;
        }
        const previousStatus = task.status;
        const nextStatus = body.status as StdioAppControlTaskStatus;
        if (nextStatus !== previousStatus) {
          const timestamp = new Date(TIMESTAMP_EPOCH + (Number(taskId) + requests.length) * 1000).toISOString();
          task.historyEvents = [
            ...(Array.isArray(task.historyEvents) ? task.historyEvents : []),
            {
              type: 'status_changed',
              from: previousStatus,
              to: nextStatus,
              ...(typeof body.actor === 'string' ? { actor: body.actor } : {}),
              timestamp,
            },
          ];
          task.status = nextStatus;
          task.updatedAt = timestamp;
          if (nextStatus === 'deleted') task.deletedAt = timestamp;
          else if (task.deletedAt) delete task.deletedAt;
        }
        sendJson(response, 200, {
          task: clone(task),
          transitions: [{ from: previousStatus, to: nextStatus }],
        });
        return;
      }

      if (method === 'PATCH' && !isStatusRoute) {
        if (!isRecord(body)) {
          sendJson(response, 400, { code: 'INVALID_PATCH', message: 'Task patch must be an object' });
          return;
        }
        for (const [key, value] of Object.entries(body)) {
          if (key === 'actor') continue;
          if (value === null) delete task[key];
          else task[key] = clone(value);
        }
        if (body.subject !== undefined || body.description !== undefined || body.owner !== undefined) {
          task.updatedAt = new Date(TIMESTAMP_EPOCH + (Number(taskId) + requests.length) * 1000).toISOString();
        }
        sendJson(response, 200, { task: clone(task) });
        return;
      }

      sendJson(response, 405, { code: 'METHOD_NOT_ALLOWED', message: `Unsupported ${method} ${url}` });
    })().catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          code: 'FIXTURE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind isolated app-control fixture');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    context,
    requests,
    setGroupChats(teamName, chats) {
      groupChats.set(teamName, clone(chats));
    },
    seedTask(teamName, input) {
      if (!/^\d+$/.test(input.id)) throw new Error(`Fixture task id must be numeric: ${input.id}`);
      const tasks = getTeamTasks(teamName);
      if (tasks.has(input.id)) throw new Error(`Duplicate fixture task id: ${input.id}`);
      const createdAt = typeof input.createdAt === 'string'
        ? input.createdAt
        : new Date(TIMESTAMP_EPOCH + Number(input.id) * 1000).toISOString();
      const status = (input.status ?? 'pending') as StdioAppControlTaskStatus;
      const task = {
        displayId: input.id,
        requirements: ['AC-1'],
        reviewState: 'none',
        comments: [],
        blockedBy: [],
        related: [],
        createdAt,
        updatedAt: createdAt,
        historyEvents: [{ type: 'task_created', status, timestamp: createdAt }],
        ...clone(input),
        id: input.id,
        status,
      } as FixtureTask;
      if (
        !Array.isArray(task.requirements) ||
        task.requirements.length === 0 ||
        task.requirements.some((id) => typeof id !== 'string' || !Object.hasOwn(VALID_REQUIREMENT_IDS, id))
      ) {
        throw new Error(`Fixture task ${input.id} must link valid requirement ids`);
      }
      tasks.set(input.id, task);
    },
    updateTask(teamName, taskId, patch) {
      const task = getTeamTasks(teamName).get(taskId);
      if (!task) throw new Error(`Unknown fixture task id: ${teamName}/${taskId}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete task[key];
        else task[key] = clone(value);
      }
    },
    getTask(teamName, taskId) {
      const task = getTeamTasks(teamName).get(taskId);
      return task ? clone(task) : undefined;
    },
    close: async () => {
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
}
