import type { IncomingHttpHeaders } from 'node:http';
import type { Worker } from 'node:worker_threads';

export interface ControlServerRequest {
  method: string | undefined;
  pathname: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface ControlServer {
  url: string;
  worker: Worker;
  setClock(now: number): void;
  mutateTask(taskId: string, patch: Record<string, unknown>): void;
  deleteTask(taskId: string): void;
  requests(): Promise<ControlServerRequest[]>;
  stop(): Promise<void>;
}

export function startControlServer(options?: {
  initialTasks?: Record<string, unknown>[];
  failStatus?: number;
}): Promise<ControlServer>;
