import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { copyCredentialsInto } from './credentials';

// L3 harness: the real desktop app with its real runtime, in a directory of its own. The app
// is told to keep every piece of its state in the sandbox (claude root, user data, runtime
// config), so the working installation and the `my-team` team are never touched.

export interface LiveSandbox {
  root: string;
  claudeRoot: string;
  userDataDir: string;
  projectDir: string;
  httpPort: number;
  remainingLoginHours: number;
}

export interface RunningApp {
  baseUrl: string;
  pid: number;
  logFile: string;
  stop(): Promise<void>;
}

export interface StartAppOptions {
  /** Directory with package.json and dist-electron of the build under test. */
  appDir: string;
  /** Path of claude-multimodel(.exe): the app is pointed at it explicitly. */
  runtimePath: string;
  /** Settings of the app for this run (thresholds of the watcher), named by the test. */
  env?: Record<string, string>;
  /**
   * Port of the Chromium remote-debugging endpoint on 127.0.0.1. A test that needs the renderer
   * (the bridge `window.electronAPI` the dialogs call) connects to it; see `rendererBridge.ts`.
   */
  debugPort?: number;
}

const APP_READY_TIMEOUT_MS = 120_000;

// Variables of the surrounding session that must not reach the sandbox app or its runtime:
// they would redirect the model traffic, switch the billing mode or join another session.
const SCRUBBED_PREFIXES = ['CLAUDE', 'ANTHROPIC', 'AGENT_TEAMS', 'ELECTRON', 'LANGFUSE'];

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export async function createSandbox(label: string): Promise<LiveSandbox> {
  const base = process.env.LIVE_SANDBOX_ROOT?.trim() || path.join(os.tmpdir(), 'agentteams-live');
  const root = path.resolve(base, `${label}-${timestamp()}`);
  const claudeRoot = path.join(root, 'claude');
  const userDataDir = path.join(root, 'user-data');
  const projectDir = path.join(root, 'project');
  for (const dir of [claudeRoot, userDataDir, projectDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# Sandbox project for live startup tests\n');

  const httpPort = await freePort();
  fs.writeFileSync(
    path.join(claudeRoot, 'agent-teams-config.json'),
    JSON.stringify(
      {
        general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark', defaultTab: 'teams' },
        // With the OpenCode MCP bridge off (CLAUDE_TEAM_OPENCODE_MCP_HTTP=0) the app starts the
        // control server at boot when it is enabled; the team routes live on it.
        httpServer: { enabled: true, port: httpPort },
      },
      null,
      2
    )
  );
  const { remainingHours } = copyCredentialsInto(claudeRoot);
  return { root, claudeRoot, userDataDir, projectDir, httpPort, remainingLoginHours: remainingHours };
}

function buildAppEnv(sandbox: LiveSandbox, options: StartAppOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SCRUBBED_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix))) continue;
    env[key] = value;
  }
  return {
    ...env,
    NODE_ENV: 'production',
    AGENT_TEAMS_DISABLE_SOURCEMAPS: '1',
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: sandbox.claudeRoot,
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: sandbox.userDataDir,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: options.runtimePath,
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(sandbox.root, 'multimodel-data'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(sandbox.root, 'multimodel-cache'),
    ...options.env,
  };
}

async function waitForControlApi(
  sandbox: LiveSandbox,
  child: ChildProcess,
  exited: () => string | null
): Promise<string> {
  const stateFile = path.join(sandbox.claudeRoot, 'team-control-api.json');
  const deadline = Date.now() + APP_READY_TIMEOUT_MS;
  let lastError = 'control address file not written yet';
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit) throw new Error(`The app exited before it was ready (${exit})`);
    try {
      const { baseUrl } = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { baseUrl: string };
      const response = await fetch(`${baseUrl}/api/teams`);
      if (response.ok) return baseUrl;
      lastError = `GET /api/teams answered ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`The control API did not come up in ${APP_READY_TIMEOUT_MS} ms: ${lastError}`);
}

export async function startApp(
  sandbox: LiveSandbox,
  options: StartAppOptions
): Promise<RunningApp> {
  if (!fs.existsSync(options.runtimePath)) {
    throw new Error(`Runtime executable not found: ${options.runtimePath}`);
  }
  const electronPath = createRequire(path.join(options.appDir, 'package.json'))('electron') as string;
  const logFile = path.join(sandbox.root, 'app.log');
  const log = fs.createWriteStream(logFile);
  const args = ['.'];
  if (options.debugPort) args.push(`--remote-debugging-port=${options.debugPort}`);
  const child = spawn(electronPath, args, {
    cwd: options.appDir,
    env: buildAppEnv(sandbox, options),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let exitText: string | null = null;
  child.once('exit', (code, signal) => {
    exitText = `code=${code} signal=${signal}`;
  });
  const pid = child.pid;
  if (!pid) throw new Error('The app process did not start');

  const stop = async (): Promise<void> => {
    if (exitText === null) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
      const deadline = Date.now() + 15_000;
      while (exitText === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    log.end();
  };

  try {
    const baseUrl = await waitForControlApi(sandbox, child, () => exitText);
    return { baseUrl, pid, logFile, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
