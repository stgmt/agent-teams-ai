import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ChildProcessModule from '@main/utils/childProcess';
import type * as PathDecoderModule from '@main/utils/pathDecoder';
import type * as ShellEnvModule from '@main/utils/shellEnv';
import type { ConfiguredMcpEntry } from '@main/services/extensions/runtime/McpConfigStateReader';
import type { TeamMemberMcpPolicy } from '@shared/types';

import type * as McpNodeRuntimeProbeModule from '../McpNodeRuntimeProbe';
import { getSpecRegistryTokenFilePath, TeamMcpConfigBuilder } from '../TeamMcpConfigBuilder';
import type * as WorkspaceMcpBundleModule from '../WorkspaceMcpBundle';

const testPaths = vi.hoisted(() => ({
  configsDir: '',
  claudeDir: '',
  mcpServerDir: '',
}));

const readerState = vi.hoisted(() => ({
  entries: [] as ConfiguredMcpEntry[],
}));

vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof PathDecoderModule>()),
  getClaudeBasePath: () => testPaths.claudeDir,
  getMcpConfigsBasePath: () => testPaths.configsDir,
  getMcpServerBasePath: () => testPaths.mcpServerDir,
}));

vi.mock('@main/utils/childProcess', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execCli: vi.fn(async () => ({ stdout: 'node-probe', stderr: '' })),
}));

vi.mock('@main/utils/shellEnv', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellEnvModule>()),
  resolveInteractiveShellEnv: vi.fn(async () => ({})),
}));

vi.mock('../McpNodeRuntimeProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof McpNodeRuntimeProbeModule>()),
  NODE_RUNTIME_PROBE_SCRIPT: 'node-probe-script',
  parseNodeRuntimeProbeMetadata: () => ({
    path: process.execPath,
    version: process.version,
    modules: '127',
  }),
  assertSupportedMcpNodeRuntime: () => undefined,
  probePackagedElectronNodeRuntime: async () => ({ ok: false, error: new Error('not packaged') }),
}));

vi.mock('../WorkspaceMcpBundle', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceMcpBundleModule>()),
  resolveWorkspaceMcpBundle: async () => path.join(testPaths.mcpServerDir, 'bundle.js'),
}));

vi.mock('@features/external-agent-connection/main', () => ({
  getDesktopMcpChildEnvironment: () => ({}),
}));

vi.mock('@main/services/extensions/runtime/McpConfigStateReader', () => ({
  McpConfigStateReader: class {
    async readConfigured(): Promise<ConfiguredMcpEntry[]> {
      return readerState.entries;
    }
  },
}));

const SPEC_REGISTRY_SERVER_NAME = 'omp-spec-kit';
const AGENT_TEAMS_SERVER_NAME = 'agent-teams';

function readGeneratedServers(configPath: string): Record<string, Record<string, unknown>> {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  return parsed.mcpServers;
}

function removeSpecRegistryTokenFile(): void {
  fs.rmSync(path.dirname(getSpecRegistryTokenFilePath()), { recursive: true, force: true });
}

function writeSpecRegistryTokenFile(raw: string): void {
  removeSpecRegistryTokenFile();
  fs.mkdirSync(path.dirname(getSpecRegistryTokenFilePath()), { recursive: true });
  fs.writeFileSync(getSpecRegistryTokenFilePath(), raw, 'utf8');
}

let testRootDir = '';

beforeAll(() => {
  testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-mcp-config-builder-'));
  testPaths.configsDir = path.join(testRootDir, 'mcp-configs');
  testPaths.claudeDir = path.join(testRootDir, 'claude');
  testPaths.mcpServerDir = path.join(testRootDir, 'mcp-server');
  // Make the development-source branch reachable without touching the real repo.
  fs.mkdirSync(path.join(testPaths.mcpServerDir, 'src'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(testRootDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.OMP_SPEC_REGISTRY_TOKEN;
  delete process.env.OMP_SPEC_REGISTRY_URL;
  readerState.entries = [];
  removeSpecRegistryTokenFile();
  fs.rmSync(testPaths.configsDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.OMP_SPEC_REGISTRY_TOKEN;
  delete process.env.OMP_SPEC_REGISTRY_URL;
  removeSpecRegistryTokenFile();
});

describe('TeamMcpConfigBuilder spec registry MCP server', () => {
  it('omits omp-spec-kit when no token is available and keeps agent-teams', async () => {
    const configPath = await new TeamMcpConfigBuilder().writeConfigFile();

    const servers = readGeneratedServers(configPath);
    expect(servers[AGENT_TEAMS_SERVER_NAME]).toBeDefined();
    expect(servers[SPEC_REGISTRY_SERVER_NAME]).toBeUndefined();
  });

  it('adds omp-spec-kit with the env token and default registry url', async () => {
    process.env.OMP_SPEC_REGISTRY_TOKEN = '  env-token-value  ';

    const configPath = await new TeamMcpConfigBuilder().writeConfigFile();

    expect(readGeneratedServers(configPath)[SPEC_REGISTRY_SERVER_NAME]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8650/mcp',
      headers: { Authorization: 'Bearer env-token-value' },
      enabled: true,
    });
  });

  it('honours OMP_SPEC_REGISTRY_URL for the registry url', async () => {
    process.env.OMP_SPEC_REGISTRY_TOKEN = 'env-token-value';
    process.env.OMP_SPEC_REGISTRY_URL = 'http://127.0.0.1:9999/custom-mcp';

    const configPath = await new TeamMcpConfigBuilder().writeConfigFile();

    expect(readGeneratedServers(configPath)[SPEC_REGISTRY_SERVER_NAME]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:9999/custom-mcp',
      headers: { Authorization: 'Bearer env-token-value' },
      enabled: true,
    });
  });

  it('falls back to the token file when the env token is absent', async () => {
    writeSpecRegistryTokenFile('  file-token-value\n');

    const configPath = await new TeamMcpConfigBuilder().writeConfigFile();

    expect(readGeneratedServers(configPath)[SPEC_REGISTRY_SERVER_NAME]).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:8650/mcp',
      headers: { Authorization: 'Bearer file-token-value' },
      enabled: true,
    });
  });

  it('ignores a blank token file', async () => {
    writeSpecRegistryTokenFile('   \n');

    const configPath = await new TeamMcpConfigBuilder().writeConfigFile();

    const servers = readGeneratedServers(configPath);
    expect(servers[AGENT_TEAMS_SERVER_NAME]).toBeDefined();
    expect(servers[SPEC_REGISTRY_SERVER_NAME]).toBeUndefined();
  });

  it('overrides an allowlisted user omp-spec-kit server with the registry config', async () => {
    process.env.OMP_SPEC_REGISTRY_TOKEN = 'env-token-value';
    readerState.entries = [
      {
        name: SPEC_REGISTRY_SERVER_NAME,
        scope: 'user',
        config: { command: 'user-owned-binary', args: ['--user-owned'] },
        status: 'connected',
      } as unknown as ConfiguredMcpEntry,
      {
        name: 'other-user-server',
        scope: 'user',
        config: { command: 'other-binary', args: [] },
        status: 'connected',
      } as unknown as ConfiguredMcpEntry,
    ];
    const policy: TeamMemberMcpPolicy = {
      mode: 'strictAllowlist',
      serverNames: [SPEC_REGISTRY_SERVER_NAME, 'other-user-server'],
    };

    const configPath = await new TeamMcpConfigBuilder().writeConfigFile(undefined, policy);

    const servers = readGeneratedServers(configPath);
    expect(servers[SPEC_REGISTRY_SERVER_NAME]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8650/mcp',
      headers: { Authorization: 'Bearer env-token-value' },
      enabled: true,
    });
    expect(servers['other-user-server']).toMatchObject({ command: 'other-binary' });
  });
});
