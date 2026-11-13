import { nativeSdkDeferred } from './nativeSdkTestHarness';
// @vitest-environment node
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import { TeamMcpConfigBuilder } from '../../../../src/main/services/team/TeamMcpConfigBuilder';
import { NodeTeamLaunchSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamLaunchSettings';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildEvidenceBasedLeadReplyInstruction,
  buildLeadServiceRefreshInstruction,
} from '../../../../src/features/lead-reporting/main';
import { NodeNativeLaunchArtifacts } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeLaunchArtifacts';

import type * as PathDecoder from '../../../../src/main/utils/pathDecoder';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, chmod: vi.fn(actual.chmod) };
});

const mcpPaths = vi.hoisted(() => ({ root: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof PathDecoder>();
  return {
    ...actual,
    getMcpConfigsBasePath: () => join(mcpPaths.root, 'mcp-configs'),
    getClaudeBasePath: () => join(mcpPaths.root, 'claude'),
  };
});
// Keep this a configuration-consumer test: compilation and the live MCP/model
// acceptance belong to the integration owner, not this focused fixture.
vi.mock('@main/services/team/WorkspaceMcpBundle', () => ({
  resolveWorkspaceMcpBundle: (root: string) =>
    Promise.resolve(join(root, 'mcp-server', 'src', 'index.ts')),
}));

const directories: string[] = [];
const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};
const token = { ...run, memberName: 'team-lead', generation: 1, operationId: 'TEST-start' };
const settings = {
  team: run,
  memberName: token.memberName,
  role: 'lead' as const,
  configurationRevision: 'TEST-revision',
  providerId: 'anthropic',
  model: 'TEST-model',
  workingDirectory: process.cwd(),
  instructions: 'TEST lead instructions',
  specIntegration: {
    scope: { projects: ['owner/project'], bindings: [] },
    environment: {
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-artifact-token',
    },
  },
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

async function setup(briefing = 'TEST canonical member briefing') {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-artifacts-'));
  directories.push(root);
  const writeConfigFile = vi.fn(() => Promise.resolve('TEST-owned-mcp.json'));
  const removeConfigFile = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve());
  const artifacts = new NodeNativeLaunchArtifacts({
    runtimeRoot: root,
    mcp: { writeConfigFile, removeConfigFile },
    controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
    leadCredential: () => 'TEST-bound-lead-credential',
    briefing: () => Promise.resolve(briefing),
    registration: {
      register: () => Promise.resolve(),
      registerLead: () => Promise.resolve(),
      release: () => Promise.resolve(),
    },
  });
  return { artifacts, writeConfigFile, removeConfigFile };
}

describe('owned native launch files and scoped MCP capability', () => {
  it('writes a lead-only launch spec and gives its credential only to the lead MCP config', async () => {
    const { artifacts, writeConfigFile, removeConfigFile } = await setup();
    const files = await artifacts.prepare(settings, token, new AbortController().signal);
    expect(writeConfigFile).toHaveBeenCalledWith(
      settings.workingDirectory,
      expect.objectContaining({
        runtimeScope: { role: 'lead', credential: 'TEST-bound-lead-credential' },
      })
    );
    const spec = JSON.parse(await readFile(files.bootstrapSpecPath!, 'utf8'));
    expect(spec).toMatchObject({
      version: 1,
      runId: run.runId,
      mode: 'launch',
      team: { name: run.teamName },
      members: [],
    });
    expect(spec.lead.permissionSeedTools).toContain('mcp__agent-teams__member_start');
    expect(spec.lead.permissionSeedTools).not.toContain('Agent');
    const prompt = await readFile(files.userPromptPath!, 'utf8');
    expect(prompt).toContain('TEST lead instructions');
    expect(prompt).toContain(buildLeadServiceRefreshInstruction());
    expect(prompt).toContain(buildEvidenceBasedLeadReplyInstruction());
    expect(prompt).toContain('message_send');
    expect(prompt).toContain('requestMessageId');
    expect(prompt).toContain('not an active human request');
    expect(prompt).not.toContain('TEST-bound-lead-credential');
    expect(files.env.AGENT_TEAMS_LEAD_START_CREDENTIAL).toBeUndefined();
    await files.dispose();
    await files.dispose();
    expect(removeConfigFile).toHaveBeenCalledOnce();
    await expect(readFile(files.bootstrapSpecPath!, 'utf8')).rejects.toThrow();
  });

  it('keeps empty configured lead context service-owned rather than inventing a human request or readiness acknowledgement', async () => {
    const { artifacts } = await setup();
    const files = await artifacts.prepare(
      { ...settings, instructions: '' },
      token,
      new AbortController().signal
    );
    try {
      const prompt = await readFile(files.userPromptPath!, 'utf8');
      expect(prompt).toContain(buildLeadServiceRefreshInstruction());
      expect(prompt).toContain('Do not invent a requestMessageId');
      expect(prompt).toContain('SendMessage is disabled');
      expect(prompt).not.toContain('Human report request:');
      expect(prompt).not.toContain('TEST-bound-lead-credential');
    } finally {
      await files.dispose();
    }
  });

  it('writes a separate member attempt with a private native context, no roster spawning and no lead credential', async () => {
    const { artifacts, writeConfigFile } = await setup();
    const member = { ...settings, memberName: 'builder', role: 'member' as const };
    const first = await artifacts.prepare(
      member,
      { ...token, memberName: 'builder' },
      new AbortController().signal
    );
    const second = await artifacts.prepare(
      member,
      { ...token, memberName: 'builder', generation: 2, operationId: 'TEST-restart' },
      new AbortController().signal
    );
    expect(first.eventsPath).not.toBe(second.eventsPath);
    expect(first.bootstrapProof?.proofToken).not.toBe(second.bootstrapProof?.proofToken);
    expect(first.bootstrapSpecPath).toBeUndefined();
    const context = JSON.parse(
      await readFile(first.env.CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH!, 'utf8')
    );
    expect(context).toMatchObject({
      schemaVersion: 1,
      kind: 'native_app_managed_bootstrap',
      mode: 'startup_context_file',
      memberName: 'builder',
      runId: run.runId,
      bootstrapProofToken: first.bootstrapProof?.proofToken,
    });
    expect(context.contextText).toContain('TEST canonical member briefing');
    expect(
      writeConfigFile.mock.calls.every(
        (call) =>
          JSON.stringify(call).includes('"role":"member"') &&
          !JSON.stringify(call).includes('TEST-bound-lead-credential')
      )
    ).toBe(true);
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('preserves non-ASCII line whitespace in the pinned native context hash contract', async () => {
    const briefing = 'TEST first \nsecond \nthird \t\r\nlast';
    const { artifacts } = await setup(briefing);
    const member = { ...settings, memberName: 'builder', role: 'member' as const };
    const files = await artifacts.prepare(
      member,
      { ...token, memberName: 'builder' },
      new AbortController().signal
    );
    try {
      const context = JSON.parse(
        await readFile(files.env.CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH!, 'utf8')
      );
      expect(context.contextText).toContain('TEST first \nsecond \nthird\nlast');
    } finally {
      await files.dispose();
    }
  });

  it('retries the same owned artifact cleanup after a transient failure and shares concurrent retry', async () => {
    const { artifacts, removeConfigFile } = await setup();
    const files = await artifacts.prepare(settings, token, new AbortController().signal);
    removeConfigFile.mockRejectedValueOnce(new Error('TEST MCP config still locked'));
    await expect(files.dispose()).rejects.toThrow('could not be removed');
    expect(removeConfigFile).toHaveBeenCalledOnce();
    await Promise.all([files.dispose(), files.dispose()]);
    expect(removeConfigFile).toHaveBeenCalledTimes(2);
    expect(removeConfigFile.mock.calls.every(([path]) => path === 'TEST-owned-mcp.json')).toBe(
      true
    );
    await files.dispose();
    expect(removeConfigFile).toHaveBeenCalledTimes(2);
  });

  it('releases the private attempt when permission setup fails before MCP configuration', async () => {
    const { artifacts, writeConfigFile } = await setup();
    const failure = new Error('TEST private permissions failed');
    // РИСК: подмена chmod проверяет владение каталогом при отказе, а не настоящие ACL Windows.
    const chmod = vi.mocked(fs.chmod).mockRejectedValueOnce(failure);
    await expect(artifacts.prepare(settings, token, new AbortController().signal)).rejects.toBe(
      failure
    );
    const directory = chmod.mock.calls[0][0];
    expect(directory).toBeTruthy();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it('removes its MCP config if a cancelled preparation cannot return ownership to the runtime', async () => {
    const { artifacts, writeConfigFile, removeConfigFile } = await setup();
    const abort = new AbortController();
    writeConfigFile.mockImplementationOnce(() => {
      abort.abort();
      return Promise.resolve('TEST-owned-mcp.json');
    });
    await expect(artifacts.prepare(settings, token, abort.signal)).rejects.toThrow();
    expect(removeConfigFile).toHaveBeenCalledWith('TEST-owned-mcp.json');
  });

  it.each([
    ['UI binding', { specProject: 'owner/project', specSlug: 'first-spec' }],
    ['first-project UI selection', { specProject: 'owner/project' }],
    [
      'canonical project-only scope',
      {
        specScope: { projects: ['owner/project'], bindings: [] },
      },
    ],
  ])(
    'gives the first lead and executor usable registry access for %s without leaking credentials',
    async (_label, binding) => {
      const root = await mkdtemp(join(tmpdir(), 'TEST-first-launch-spec-'));
      directories.push(root);
      mcpPaths.root = root;
      // A loopback registry boundary fixture, not a provider or live-acceptance
      // substitute. A missing/wrong credential cannot receive its tool catalog.
      const registry = createServer((request, response) => {
        if (request.headers.authorization !== 'Bearer TEST-first-launch-token') {
          response.writeHead(401).end();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ tools: [{ name: 'spec_patch' }] }));
      });
      const listening = nativeSdkDeferred<void>();
      registry.once('error', listening.reject);
      registry.listen(0, '127.0.0.1', listening.resolve);
      await listening.promise;
      const address = registry.address();
      if (!address || typeof address === 'string') throw new Error('TEST registry did not listen');
      const registryUrl = `http://127.0.0.1:${address.port}/mcp`;
      const metadata = new TeamMetaStore();
      await metadata.writeMeta(
        run.teamName,
        {
          runtimeSelectionVersion: 1,
          cwd: root,
          providerId: 'anthropic',
          model: 'TEST-model',
          createdAt: 1,
          ...binding,
        },
        root
      );
      const launches = new NodeTeamLaunchSettings({
        teamsRoot: root,
        metadata,
        members: {
          getMeta: async () => ({
            version: 1 as const,
            members: [{ name: 'builder', role: 'Builder' }],
          }),
        },
        specRegistryEnvironment: async () => ({
          OMP_SPEC_REGISTRY_URL: registryUrl,
          OMP_SPEC_REGISTRY_TOKEN: 'TEST-first-launch-token',
        }),
      });
      const artifacts = new NodeNativeLaunchArtifacts({
        runtimeRoot: root,
        mcp: new TeamMcpConfigBuilder(),
        controlUrl: async () => 'http://127.0.0.1:9999',
        leadCredential: () => 'TEST-bound-lead-credential',
        briefing: async () => 'TEST member briefing',
        registration: {
          register: async () => undefined,
          registerLead: async () => undefined,
          release: async () => undefined,
        },
      });
      try {
        await launches.capture(run);
        for (const memberName of ['team-lead', 'builder']) {
          const launch = await launches.findConfiguredMember(run, memberName);
          expect(launch).not.toBeNull();
          const files = await artifacts.prepare(
            launch!,
            { ...token, memberName },
            new AbortController().signal
          );
          try {
            const config = JSON.parse(await readFile(files.mcpConfigPath, 'utf8'));
            const server = config.mcpServers['agent-teams'];
            expect(server.env.OMP_SPEC_REGISTRY_URL).toBe(registryUrl);
            const catalog = await fetch(server.env.OMP_SPEC_REGISTRY_URL, {
              headers: { Authorization: `Bearer ${server.env.OMP_SPEC_REGISTRY_TOKEN}` },
            });
            expect(catalog.status).toBe(200);
            expect(await catalog.json()).toEqual({ tools: [{ name: 'spec_patch' }] });
            const scope = JSON.parse(server.env.AGENT_TEAMS_SPEC_SCOPE);
            expect(scope.projects).toContain('owner/project');
            expect(scope.bindings).toHaveLength('specSlug' in binding ? 1 : 0);
            expect(JSON.stringify(files.env)).not.toContain('TEST-first-launch-token');
            const publicContext = files.userPromptPath
              ? await readFile(files.userPromptPath, 'utf8')
              : await readFile(
                  files.env.CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH!,
                  'utf8'
                );
            expect(publicContext).not.toContain('TEST-first-launch-token');
          } finally {
            await files.dispose();
          }
        }
      } finally {
        const closed = nativeSdkDeferred<void>();
        registry.close((error) => (error ? closed.reject(error) : closed.resolve()));
        await closed.promise;
      }
    }
  );
});
