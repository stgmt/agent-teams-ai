// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createNativeTeamLifecycle } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamLifecycle';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

describe('native lifecycle composition admission', () => {
  it('materializes the full configured roster before provider preparation and releases its claim on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-config-composition-'));
    directories.push(root);
    const teamsRoot = join(root, 'teams');
    const teamName = 'test-configured-team';
    await mkdir(join(teamsRoot, teamName), { recursive: true });
    const configPath = join(teamsRoot, teamName, 'config.json');
    const context = new BoundControlContext('TEST-app', root);
    const request = { expectedContext: context.snapshot(), teamName };
    let preparations = 0;
    const prepareTrust = vi.fn<
      (provider: string, cwd: string, signal: AbortSignal) => Promise<string[]>
    >(() => Promise.resolve([]));
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }));
    const lifecycle = createNativeTeamLifecycle({
      owner: context.snapshot(),
      openCodeLeadDelivery: {
        relayOpenCodeMemberInboxMessages,
      } as never,
      runtimeRoot: join(root, 'attempts'),
      workspaceRoot: join(root, 'workspaces'),
      teamsRoot,
      provider: {
        prepareWorkspaceTrust: (launch, signal) =>
          prepareTrust(launch.providerId, launch.workingDirectory, signal),
        async executable() {
          const saved = JSON.parse(await readFile(configPath, 'utf8'));
          expect(saved.members.map((row: { name: string }) => row.name)).toEqual([
            'team-lead',
            'builder',
          ]);
          expect(saved.appManagedRun.identity).toEqual(lifecycle.snapshot(teamName).identity);
          preparations++;
          throw new Error('TEST stops before provider authentication or CLI spawn');
        },
        environment: () => Promise.reject(new Error('Unexpected provider authentication')),
        resolveIdentity: () => Promise.reject(new Error('Unexpected identity resolution')),
        runtimeArgs: () => Promise.reject(new Error('Unexpected runtime arguments')),
      },
      settings: {
        metadata: {
          getMeta: () =>
            Promise.resolve({ version: 1, providerId: 'anthropic', cwd: root, createdAt: 1 }),
        },
        members: {
          getMeta: () => Promise.resolve({ version: 1, members: [{ name: 'builder' }] }),
        },
      },
      mcp: {
        writeConfigFile: () => Promise.reject(new Error('Unexpected MCP configuration')),
        removeConfigFile: () => Promise.resolve(),
      },
      inbox: {
        sendMessage: () => Promise.reject(new Error('Unexpected member registration')),
      },
      controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
      briefing: () => Promise.resolve('TEST briefing'),
      invalidate: vi.fn(),
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
    const [receipt, duplicate] = await Promise.all([
      lifecycle.commands.launch(request),
      lifecycle.commands.launch(request),
    ]);
    const run = receipt.run;
    expect(duplicate).toEqual(receipt);
    expect(run).toMatchObject({ ...request.expectedContext, teamName });
    expect(run.runId).toBeTruthy();
    expect(lifecycle.runs.hasRun(run)).toBe(true);
    expect(lifecycle.runs.isLive(run)).toBe(true);
    expect(lifecycle.runs.find(teamName)?.identity).toEqual(run);
    expect(Object.keys(receipt)).toEqual(['run']);
    expect(JSON.stringify(receipt)).not.toContain('leadCredential');
    await expect.poll(() => preparations).toBe(2);
    expect(prepareTrust).toHaveBeenCalledTimes(2);
    expect(prepareTrust).toHaveBeenCalledWith('anthropic', root, expect.any(AbortSignal));
    await expect
      .poll(() =>
        Object.values(lifecycle.snapshot(teamName).members).every(
          (member) => member.phase === 'failed'
        )
      )
      .toBe(true);
    expect(await lifecycle.commands.launch(request)).toEqual(receipt);
    lifecycle.liveLeadMessages.push(
      run,
      {
        messageId: 'TEST-live-lead-message',
        from: 'team-lead',
        to: 'user',
        text: 'TEST live overlay',
        timestamp: '2026-10-31T00:00:00.000Z',
        read: true,
      },
      'TEST-session'
    );
    expect(lifecycle.liveLeadMessages.read(run, null)).toHaveLength(1);
    expect(preparations).toBe(2);
    // The lifecycle owns the ledger driver, so a wake armed here reaches the
    // production ledger port through it. Cancellation on release is covered
    // where it is decidable: `NativeOpenCodePromptDeliverySupervisor` drops a
    // team's armed wakes (this gate would mask a missing cancel later, because a
    // stopped run is not live).
    expect(lifecycle.promptDelivery).not.toBeNull();
    lifecycle.promptDelivery?.scheduleDeliveryVerification({
      teamName,
      memberName: 'builder',
      messageId: 'TEST-armed-wake',
      delayMs: 600,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledTimes(1);
    expect(relayOpenCodeMemberInboxMessages.mock.calls[0]?.slice(0, 2)).toEqual([
      teamName,
      'builder',
    ]);
    await lifecycle.commands.stop({ ...request, runId: run.runId });
    expect(lifecycle.liveLeadMessages.read(run, null)).toEqual([]);
    expect(JSON.parse(await readFile(configPath, 'utf8')).appManagedRun).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, 'utf8')).members).toHaveLength(2);
    const next = await lifecycle.commands.launch(request);
    expect(next.run.runId).not.toBe(run.runId);
    await expect(lifecycle.commands.stop({ ...request, runId: run.runId })).rejects.toThrow(
      'stale'
    );
    await context.closeAdmission();
    await lifecycle.shutdown();
    expect(lifecycle.snapshot(teamName)).toMatchObject({
      desired: 'stopped',
      resources: 'released',
    });
    expect(JSON.parse(await readFile(configPath, 'utf8')).appManagedRun).toBeUndefined();
    context.rebind(root);
    await expect(
      lifecycle.commands.launch({ ...request, expectedContext: context.snapshot() })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
    await expect(
      lifecycle.launchConfigured({ ...next.run, runId: 'TEST-after-shutdown' })
    ).rejects.toThrow('APP_CONTEXT_MISMATCH');
  });

  it('can admit the next run when cancellation wins just after canonical settings were captured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-capture-cancel-'));
    directories.push(root);
    const teamsRoot = join(root, 'teams');
    const teamName = 'test-capture-cancel';
    await mkdir(join(teamsRoot, teamName), { recursive: true });
    const context = new BoundControlContext('TEST-app', root);
    const run = { ...context.snapshot(), teamName, runId: 'TEST-run' };
    let stop: Promise<void> | undefined;
    let reads = 0;
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }));
    const lifecycle = createNativeTeamLifecycle({
      owner: context.snapshot(),
      openCodeLeadDelivery: {
        relayOpenCodeMemberInboxMessages,
      } as never,
      runtimeRoot: join(root, 'attempts'),
      workspaceRoot: join(root, 'workspaces'),
      teamsRoot,
      provider: {
        prepareWorkspaceTrust: () => Promise.resolve([]),
        executable: () => Promise.reject(new Error('TEST no CLI')),
        environment: () => Promise.reject(new Error('TEST no auth')),
        resolveIdentity: () => Promise.reject(new Error('TEST no identity')),
        runtimeArgs: () => Promise.reject(new Error('TEST no arguments')),
      },
      settings: {
        metadata: {
          getMeta() {
            if (++reads === 1)
              queueMicrotask(() => {
                stop = lifecycle.stopConfigured(run);
              });
            return Promise.resolve({
              version: 1 as const,
              providerId: 'anthropic' as const,
              cwd: root,
              createdAt: 1,
            });
          },
        },
        members: {
          getMeta: () => Promise.resolve({ version: 1, members: [] }),
        },
      },
      mcp: {
        writeConfigFile: () => Promise.reject(new Error('TEST no MCP')),
        removeConfigFile: () => Promise.resolve(),
      },
      inbox: { sendMessage: () => Promise.reject(new Error('TEST no inbox')) },
      controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
      briefing: () => Promise.resolve('TEST'),
      invalidate: vi.fn(),
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
    await expect(lifecycle.launchConfigured(run)).rejects.toThrow();
    await stop;
    const next = { ...run, runId: 'TEST-next' };
    await lifecycle.launchConfigured(next);
    await lifecycle.stopConfigured(next);
  });

  it('cancels a roster read without preparing a process, capturing late settings or exposing mutation internals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-composition-'));
    directories.push(root);
    const teamsRoot = join(root, 'teams');
    await mkdir(teamsRoot);
    const context = new BoundControlContext('TEST-app', root);
    const run = { ...context.snapshot(), teamName: 'test-composed-team', runId: 'TEST-run' };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const metadata = vi.fn(async () => {
      await pending;
      return { version: 1 as const, providerId: 'anthropic' as const, cwd: root, createdAt: 1 };
    });
    const executable = vi.fn(() =>
      Promise.reject(new Error('Cancelled launch must not prepare a provider'))
    );
    const writeConfigFile = vi.fn(() =>
      Promise.reject(new Error('Cancelled launch must not prepare MCP'))
    );
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
    }));
    const lifecycle = createNativeTeamLifecycle({
      owner: context.snapshot(),
      openCodeLeadDelivery: {
        relayOpenCodeMemberInboxMessages,
      } as never,
      runtimeRoot: join(root, 'attempts'),
      workspaceRoot: join(root, 'workspaces'),
      teamsRoot,
      provider: {
        prepareWorkspaceTrust: () => Promise.resolve([]),
        executable,
        environment: () => Promise.reject(new Error('Unexpected provider preparation')),
        resolveIdentity: () => Promise.reject(new Error('Unexpected identity resolution')),
        runtimeArgs: () => Promise.reject(new Error('Unexpected runtime argument preparation')),
      },
      settings: {
        metadata: { getMeta: metadata },
        members: {
          getMeta: () => Promise.resolve({ version: 1, members: [{ name: 'builder' }] }),
        },
      },
      mcp: { writeConfigFile, removeConfigFile: () => Promise.resolve() },
      inbox: {
        sendMessage: () => Promise.reject(new Error('Cancelled launch must not register')),
      },
      controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
      briefing: () => Promise.resolve('TEST briefing'),
      invalidate: vi.fn(),
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
    const starting = lifecycle.launchConfigured(run);
    const rejected = expect(starting).rejects.toThrow();
    await expect.poll(() => metadata.mock.calls.length).toBe(1);
    await lifecycle.stopConfigured(run);
    finish();
    await rejected;
    expect(executable).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect('teams' in lifecycle).toBe(false);
    expect('registry' in lifecycle).toBe(false);
    await expect(
      lifecycle.leadStart.execute('TEST-never-issued', { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
  });
});
