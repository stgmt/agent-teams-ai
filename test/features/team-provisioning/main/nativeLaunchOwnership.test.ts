// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeClaudeLaunchPlanner } from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeLaunchPlanner';
import { NodeNativeLaunchArtifacts } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeLaunchArtifacts';
import { NodeNativeMemberRegistration } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeMemberRegistration';

const directories: string[] = [];
const subscriptions: (() => void)[] = [];
const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-native-team',
  runId: 'TEST-run',
};
const token = { ...run, memberName: 'builder', generation: 1, operationId: 'TEST-start' };
const settings = {
  team: run,
  memberName: 'builder',
  role: 'member' as const,
  configurationRevision: 'TEST-revision',
  providerId: 'anthropic',
  model: 'TEST-model',
  workingDirectory: process.cwd(),
  instructions: 'TEST',
};

afterEach(async () => {
  subscriptions.splice(0).forEach((dispose) => dispose());
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

describe('native launch artifact, registration and proof ownership integration', () => {
  it('accepts readiness only after the exact registered member receives and returns its private startup proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-launch-ownership-'));
    directories.push(root);
    const teamsRoot = join(root, 'teams');
    await mkdir(join(teamsRoot, run.teamName), { recursive: true });
    const configPath = join(teamsRoot, run.teamName, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        name: run.teamName,
        appManagedRun: { identity: run, configurationRevision: settings.configurationRevision },
        leadAgentId: `team-lead@${run.teamName}`,
        members: [{ name: 'team-lead', agentId: `team-lead@${run.teamName}` }, { name: 'builder' }],
      })
    );
    const sent: unknown[] = [];
    const registration = new NodeNativeMemberRegistration({
      teamsRoot,
      invalidate: vi.fn(),
      inbox: {
        sendMessage(teamName, message, options) {
          expect(options?.shouldStillWrite?.()).toBe(true);
          sent.push({ teamName, message });
          return Promise.resolve({ messageId: message.messageId!, deliveredToInbox: true });
        },
      },
    });
    const artifacts = new NodeNativeLaunchArtifacts({
      runtimeRoot: join(root, 'attempts'),
      mcp: {
        writeConfigFile: () => Promise.resolve('TEST-mcp.json'),
        removeConfigFile: () => Promise.resolve(),
      },
      controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
      leadCredential: () => {
        throw new Error('Member must not request lead capability');
      },
      briefing: () => Promise.resolve('TEST canonical briefing'),
      registration,
    });
    const planner = new NativeClaudeLaunchPlanner({
      prepareWorkspace: (launch) =>
        Promise.resolve({ ...launch, taskLedgerProjectDirectory: join(root, 'TEST-ledger') }),
      prepareProvider: () => Promise.resolve({ executable: 'TEST-cli', args: [], env: {} }),
      prepareArtifacts: (launch, attempt, signal) => artifacts.prepare(launch, attempt, signal),
    });
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    const identity = { pid: process.pid, birthId: 'TEST-owned-birth' };
    const connected = vi.fn();
    const failed = vi.fn();
    subscriptions.push(plan.connection!.subscribe(identity, { connected, failed }));
    await plan.afterSpawn!(identity, new AbortController().signal);
    expect(sent).toHaveLength(1);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const member = config.members.find((row: { name: string }) => row.name === 'builder');
    const context = JSON.parse(
      await readFile(plan.env.CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH!, 'utf8')
    );
    expect(member.bootstrapProofToken).toBe(context.bootstrapProofToken);
    expect(member.runtimeProcessBirthId).toBe(identity.birthId);
    expect(connected).not.toHaveBeenCalled();
    // РИСК: тест записывает формат подтверждения закреплённого CLI; вызов модели и авторизацию поставщика он не проверяет.
    await writeFile(
      plan.env.CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH!,
      JSON.stringify({
        version: 1,
        type: 'bootstrap_confirmed',
        timestamp: new Date().toISOString(),
        pid: identity.pid,
        teamName: run.teamName,
        agentName: token.memberName,
        runId: run.runId,
        bootstrapRunId: run.runId,
        source: 'native_app_managed_bootstrap_private_turn',
        bootstrapProofToken: context.bootstrapProofToken,
        contextHash: context.contextHash,
        briefingHash: context.briefingHash,
      }) + '\n',
      { flag: 'a' }
    );
    await expect.poll(() => connected.mock.calls.length).toBe(1);
    expect(failed).not.toHaveBeenCalled();
    subscriptions.pop()?.();
    await plan.dispose?.();
  });
});
