// @vitest-environment node
import {
  installNativeSdkHostFixture,
  installNativeTaskControlFixture,
  nativeSpecScope,
  nativeSpecRegistryEnvironment,
} from './nativeSdkTestHarness';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createNodeLeadReporting } from '../../../../src/features/lead-reporting/main';
import { createNativeTeamLifecycle } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamLifecycle';
const sdkHost = installNativeSdkHostFixture();
const bindTaskControl = installNativeTaskControlFixture();

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-lead-credential-'));
  directories.push(root);
  const teamsRoot = join(root, 'teams');
  const teamName = 'test-lead-credential';
  await mkdir(join(teamsRoot, teamName), { recursive: true });
  const context = new BoundControlContext('TEST-app', root);
  await bindTaskControl(root, context.snapshot());
  const request = { expectedContext: context.snapshot(), teamName };
  const credentials: string[] = [];
  // РИСК: real composition/config/MCP admission is covered; the MCP port rejects before OS/model launch.
  const lifecycle = createNativeTeamLifecycle({
    owner: context.snapshot(),
    sdkHost: sdkHost(),
    readStartupTasks: async () => [],
    createController: () => ({
      taskBoard: { deliverStartupWorkAsync: async () => ({ delivered: [], skipped: [] }) },
    }),
    runtimeRoot: join(root, 'attempts'),
    workspaceRoot: join(root, 'workspaces'),
    teamsRoot,
    settings: {
      specRegistryEnvironment: nativeSpecRegistryEnvironment,
      metadata: {
        getMeta: () =>
          Promise.resolve({
            version: 1,
            providerId: 'anthropic',
            cwd: root,
            createdAt: 1,
            specScope: nativeSpecScope,
          }),
      },
      members: { getMeta: () => Promise.resolve({ version: 1, members: [] }) },
    },
    provider: {
      prepareWorkspaceTrust: () => Promise.resolve([]),
      executable: () => Promise.resolve('TEST-must-not-spawn'),
      environment: () =>
        Promise.resolve({ env: {}, authSource: 'none', geminiRuntimeAuth: null, providerArgs: [] }),
      resolveIdentity: () =>
        Promise.resolve({
          providerId: 'anthropic',
          providerBackendId: null,
          selectedModel: null,
          selectedModelKind: 'default',
          resolvedLaunchModel: null,
          catalogId: null,
          catalogSource: 'unavailable',
          catalogFetchedAt: null,
          selectedEffort: null,
          resolvedEffort: null,
        }),
      runtimeArgs: () =>
        Promise.resolve({
          providerArgs: [],
          fastModeArgs: [],
          runtimeTurnSettledHookArgs: [],
          settingsArgs: [],
          extraArgs: [],
          inheritedProviderArgs: [],
          appManagedSettingsPath: null,
        }),
    },
    mcp: {
      writeConfigFile: (_cwd, options) => {
        if (options.runtimeScope.role === 'lead') credentials.push(options.runtimeScope.credential);
        return Promise.reject(new Error('TEST stops before OS spawn'));
      },
      removeConfigFile: () => Promise.resolve(),
    },
    inbox: { sendMessage: () => Promise.reject(new Error('TEST no registration')) },
    controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
    briefing: () => Promise.resolve('TEST'),
    invalidate: () => undefined,
    contextInvalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
  const launch = async () => {
    const expectedCredentials = credentials.length + 1;
    const receipt = await lifecycle.commands.launch(request);
    await expect.poll(() => credentials.length).toBe(expectedCredentials);
    await expect
      .poll(() => lifecycle.snapshot(teamName).members['team-lead'].resources)
      .toBe('released');
    return receipt.run;
  };
  return { lifecycle, context, request, credentials, launch, teamsRoot, teamName };
}

describe('public native lead authority query', () => {
  it('resolves only the capability already issued to the scoped MCP child without changing lifecycle state', async () => {
    const { lifecycle, request, credentials, launch } = await setup();
    const run = await launch();
    try {
      const before = await lifecycle.queries.snapshot(request);
      const resolved = lifecycle.resolveLeadCredential(credentials[0]);
      expect(resolved).toEqual(run);
      expect(Object.isFrozen(resolved)).toBe(true);
      expect(lifecycle.resolveLeadCredential(credentials[0])).toBe(resolved);
      expect(await lifecycle.queries.snapshot(request)).toEqual(before);
      expect(JSON.stringify(before)).not.toContain(credentials[0]);
      expect(() => lifecycle.resolveLeadCredential('TEST-not-issued')).toThrow('Unauthorized');
      await expect(
        lifecycle.leadStart.execute(credentials[0], { memberName: 'unknown' })
      ).rejects.toThrow('Member is not configured: unknown');
    } finally {
      await lifecycle.stopConfigured(run);
    }
  });

  it('uses the same issued authority in the reporting composition and closes only the durably appended human reply', async () => {
    const { lifecycle, request, credentials, launch, teamsRoot, teamName } = await setup();
    const run = await launch();
    const deliveries: string[] = [];
    const reporting = createNodeLeadReporting({
      teamsRoot,
      members: { getMeta: () => Promise.reject(new Error('TEST ordinary reply needs no roster')) },
      resolveLead: (credential) => lifecycle.resolveLeadCredential(credential),
      lifecycle: async (expected) => {
        const snapshot = await lifecycle.queries.snapshot(request);
        return snapshot?.identity.runId === expected.runId ? snapshot : null;
      },
      // The delivery path verifies completion against the canonical board, so the
      // ordinary-reply case reads an empty board rather than refusing the read.
      tasks: () => Promise.resolve([]),
      taskChanges: () => Promise.reject(new Error('TEST ordinary reply needs no task changes')),
      leadName: () => Promise.resolve('team-lead'),
      delivered: (_identity, report) => deliveries.push(report.requestMessageId),
      changed: () => undefined,
    });
    const inbox = join(teamsRoot, teamName, 'inboxes', 'user.json');
    try {
      await reporting.acceptHumanRequest({
        run,
        requestMessageId: 'TEST-human-1',
        text: 'What is two plus two?',
        origin: { kind: 'human' },
        isMeta: false,
      });
      expect(deliveries).toEqual([]);
      expect(() => reporting.reply('TEST-foreign', 'TEST-human-1', 'Four.')).toThrow(
        'Unauthorized'
      );
      await expect(readFile(inbox)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = await reporting.reply(credentials[0], 'TEST-human-1', 'Four.');
      expect(result.requestMessageId).toBe('TEST-human-1');
      expect(deliveries).toEqual(['TEST-human-1']);
      const persisted = await readFile(inbox, 'utf8');
      expect(JSON.parse(persisted)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Four.',
            replyToMessageIds: ['TEST-human-1'],
            leadSessionId: run.runId,
            replyChannel: 'explicit',
          }),
        ])
      );
      await reporting.acceptHumanRequest({
        run,
        requestMessageId: 'TEST-human-2',
        text: 'What is three plus three?',
        origin: { kind: 'human' },
        isMeta: false,
      });
      await lifecycle.stopConfigured(run);
      expect(() => reporting.reply(credentials[0], 'TEST-human-2', 'Six.')).toThrow('Unauthorized');
      expect(await readFile(inbox, 'utf8')).toBe(persisted);
      expect(deliveries).toEqual(['TEST-human-1']);
    } finally {
      await lifecycle.stopConfigured(run);
    }
  });

  it('revokes the old credential on stop and never resolves it to a successor run', async () => {
    const { lifecycle, credentials, launch } = await setup();
    const first = await launch();
    const credential = credentials[0];
    await lifecycle.stopConfigured(first);
    expect(() => lifecycle.resolveLeadCredential(credential)).toThrow('Unauthorized');
    const next = await launch();
    try {
      expect(next.runId).not.toBe(first.runId);
      await expect.poll(() => credentials.length).toBe(2);
      expect(credentials[1]).not.toBe(credential);
      expect(lifecycle.resolveLeadCredential(credentials[1])).toEqual(next);
      expect(() => lifecycle.resolveLeadCredential(credential)).toThrow('Unauthorized');
    } finally {
      await lifecycle.stopConfigured(next);
    }
  });

  it('rejects an issued credential immediately when the app connection generation changes', async () => {
    const { lifecycle, context, credentials, launch } = await setup();
    const run = await launch();
    try {
      context.transportReplaced();
      expect(() => lifecycle.resolveLeadCredential(credentials[0])).toThrow('APP_CONTEXT_MISMATCH');
    } finally {
      await lifecycle.stopConfigured(run);
    }
  });

  it('rejects an issued credential while root admission is closed, without holding a root lease', async () => {
    const { lifecycle, context, credentials, launch } = await setup();
    const run = await launch();
    try {
      expect(lifecycle.resolveLeadCredential(credentials[0])).toEqual(run);
      await context.closeAdmission();
      expect(() => lifecycle.resolveLeadCredential(credentials[0])).toThrow('APP_CONTEXT_MISMATCH');
    } finally {
      await lifecycle.stopConfigured(run);
    }
  });
});
