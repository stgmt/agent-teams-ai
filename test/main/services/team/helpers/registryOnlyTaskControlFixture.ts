import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ControlServer {
  url: string;
  deleteTask(taskId: string): void;
  stop(): Promise<void>;
}

const require = createRequire(import.meta.url);
const controlServerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../agent-teams-controller/test/helpers/controlServer.js'
);
const { startControlServer } = require(controlServerPath) as {
  startControlServer(): Promise<ControlServer>;
};
const envKeys = [
  'AGENT_TEAMS_BOUND_CONTROL_URL',
  'AGENT_TEAMS_BOUND_CONTEXT_JSON',
  'AGENT_TEAMS_MCP_CLAUDE_DIR',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const claudeDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-registry-only-control-'));
const server = await startControlServer();

process.env.AGENT_TEAMS_BOUND_CONTROL_URL = server.url;
process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({
  appInstanceId: 'registry-only-test-app',
  dataRootFingerprint: 'registry-only-test-root',
  connectionGeneration: 1,
});
process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeDir;

// Load after binding the local app API. The controller captures its app context
// at module initialization so later environment changes cannot retarget it.
const { createController, protocols } = await import('agent-teams-controller');
const taskIdsByTeam = new Map<string, string[]>();
let disposed = false;

export const registryOnlyTaskControlFixture = {
  claudeDir,
  createController,
  protocols,
  trackTask(teamName: string, taskId: string): void {
    const ids = taskIdsByTeam.get(teamName) ?? [];
    ids.push(taskId);
    taskIdsByTeam.set(teamName, ids);
  },
  async clearTeam(teamName: string): Promise<void> {
    for (const taskId of taskIdsByTeam.get(teamName) ?? []) {
      server.deleteTask(taskId);
    }
    taskIdsByTeam.delete(teamName);
    await rm(path.join(claudeDir, 'teams', teamName), { recursive: true, force: true });
  },
  async dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      for (const teamName of taskIdsByTeam.keys()) {
        for (const taskId of taskIdsByTeam.get(teamName) ?? []) server.deleteTask(taskId);
      }
    } finally {
      await server.stop();
      await rm(claudeDir, { recursive: true, force: true });
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
};
