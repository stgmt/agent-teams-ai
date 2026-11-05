import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { createRegistryTeamTaskWriter } from '../../../../../src/main/services/team/registry/RegistryTeamTaskWriterFactory';
import type { RegistryTeamTaskWriter } from '../../../../../src/main/services/team/registry/RegistryTeamTaskWriter';
import type { TeamSpecBinding } from '../../../../../src/main/services/team/registry/TeamSpecBinding';

const execFileAsync = promisify(execFile);
const binding = { project: 'sandbox/live-tests', spec: 'spec-kernel' } as const;
const ENV_KEYS = ['OMP_SPEC_REGISTRY_URL', 'OMP_SPEC_REGISTRY_TOKEN', 'OMP_SPEC_REGISTRY_TOKEN_FILE', 'HOME', 'USERPROFILE'] as const;

type RegistryService = {
  server: Server;
  store?: { close?: () => void };
  sync?: { stop?: () => void };
  projection?: { stop?: () => void };
};

export interface RegistryLiveFixture {
  binding: TeamSpecBinding;
  writer(teamName: string): Promise<RegistryTeamTaskWriter>;
  dispose(): Promise<void>;
}

/** Real registry and Git repository, isolated from the operator's registry and credentials. */
export async function createRegistryLiveFixture(tempDir: string): Promise<RegistryLiveFixture> {
  const source = process.env.AGENT_TEAMS_TEST_REGISTRY_SOURCE?.trim();
  if (!source || !path.isAbsolute(source)) {
    throw new Error('Set AGENT_TEAMS_TEST_REGISTRY_SOURCE to an absolute path to the registry source checkout.');
  }
  const home = path.join(tempDir, 'registry-home');
  const bare = path.join(tempDir, 'registry.git');
  const work = path.join(tempDir, 'registry-seed');
  const tokenFile = path.join(tempDir, 'registry-token');
  const token = randomBytes(32).toString('hex');
  const serviceToken = randomBytes(32).toString('hex');
  const bridgeToken = randomBytes(32).toString('hex');
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: tempDir,
    TMP: tempDir,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = async (args: string[], cwd = tempDir) => {
    await execFileAsync('git', args, { cwd, env: gitEnv });
  };
  let auth: Server | undefined;
  let service: RegistryService | undefined;
  try {
    await fs.mkdir(home, { recursive: true });
    await git(['init', '--bare', '--initial-branch=main', bare]);
    await git(['init', '--initial-branch=main', work]);
    await git(['config', 'user.email', 'sandbox@example.invalid'], work);
    await git(['config', 'user.name', 'Sandbox'], work);
    const specDir = path.join(work, '.specs', binding.spec);
    await fs.mkdir(path.dirname(specDir), { recursive: true });
    await fs.cp(path.join(source, 'tests', 'fixtures', 'kernel', 'real-corpus', '.specs', binding.spec), specDir, { recursive: true });
    await fs.writeFile(path.join(specDir, 'TASKS.md'), '# Tasks\n');
    await fs.writeFile(path.join(work, '.spec-kit.json'), JSON.stringify({
      schema: 'omp-spec-kit/spec-binding@1', project: binding.project, spec: binding.spec,
      repo: bare, branch: `spec-${binding.spec}`, createdAt: '2026-01-01T00:00:00.000Z', owner: 'sandbox',
    }));
    await git(['checkout', '-b', `spec-${binding.spec}`], work);
    await git(['add', '.'], work);
    await git(['commit', '-m', 'Seed isolated spec'], work);
    await git(['push', bare, `HEAD:refs/heads/spec-${binding.spec}`], work);
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    auth = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.headers.authorization === `Bearer ${token}` && url.pathname === '/hub/api/rest/users/me') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'sandbox-user', login: 'sandbox', banned: false }));
      } else if (request.headers.authorization === `Bearer ${serviceToken}` && url.pathname === '/hub/api/rest/users') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ users: [{ id: 'sandbox-user', login: 'sandbox', banned: false, transitiveGroups: [{ name: 'sandbox' }] }] }));
      } else {
        response.writeHead(401).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      auth!.once('error', reject);
      auth!.listen(0, '127.0.0.1', resolve);
    });
    const authAddress = auth.address();
    if (!authAddress || typeof authAddress === 'string') throw new Error('Sandbox auth did not bind TCP.');
    const configPath = path.join(tempDir, 'registry-projects.json');
    await fs.writeFile(configPath, JSON.stringify({
      projects: [{ id: binding.project }],
      bindings: [{ project: binding.project, repoUrl: bare }],
      tenants: [{ tenant: 'sandbox', projects: [binding.project], hubGroups: ['sandbox'], defaultProject: binding.project }],
      auth: {
        youtrack: { baseUrl: `http://127.0.0.1:${authAddress.port}`, serviceToken },
        appBridge: { token: bridgeToken }, roleGroups: { owner: ['sandbox'] },
      },
    }), { mode: 0o600 });
    // The external checkout is selected explicitly at runtime and is not an app dependency.
    const serviceModule = createRequire(import.meta.url)(path.join(source, 'src/service/index.js'));
    service = await serviceModule.startService({
      configPath, cloneDir: path.join(tempDir, 'registry-clone'), storeFile: path.join(tempDir, 'registry.db'),
      port: 0, host: '127.0.0.1', syncIntervalMs: 0, env: gitEnv,
      identity: { name: 'Sandbox', email: 'sandbox@example.invalid' }, logger: () => {},
    }) as RegistryService;
    const address = service.server.address();
    if (!address || typeof address === 'string') throw new Error('Sandbox registry did not bind TCP.');
    process.env.OMP_SPEC_REGISTRY_URL = `http://127.0.0.1:${address.port}/mcp`;
    process.env.OMP_SPEC_REGISTRY_TOKEN = token;
    process.env.OMP_SPEC_REGISTRY_TOKEN_FILE = tokenFile;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const dispose = async () => {
      for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      service?.sync?.stop?.();
      service?.projection?.stop?.();
      await Promise.all([service?.server, auth].filter((server): server is Server => !!server).map((server) => {
        return new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }));
      service?.store?.close?.();
    };
    return {
      binding,
      writer: (teamName: string) => createRegistryTeamTaskWriter({ teamName, binding }),
      dispose,
    };
  } catch (error) {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    service?.sync?.stop?.();
    service?.server.close();
    service?.store?.close?.();
    auth?.close();
    throw error;
  }
}
