// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeNativeMemberRegistration } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeMemberRegistration';

const directories: string[] = [];
const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
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
const processIdentity = { pid: 101, birthId: 'TEST-birth' };
const proof = {
  proofToken: 'TEST-proof',
  contextHash: 'TEST-context',
  briefingHash: 'TEST-briefing',
  boundaryMs: Date.now(),
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-registration-'));
  directories.push(root);
  const teamDirectory = join(root, run.teamName);
  await mkdir(teamDirectory);
  const configPath = join(teamDirectory, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: run.teamName,
      appManagedRun: { identity: run, configurationRevision: settings.configurationRevision },
      leadAgentId: `team-lead@${run.teamName}`,
      members: [
        { name: 'team-lead', agentId: `team-lead@${run.teamName}` },
        { name: 'builder', role: 'TEST builder' },
      ],
    })
  );
  const sendMessage = vi.fn(() =>
    Promise.resolve({ messageId: 'TEST-message', deliveredToInbox: true })
  );
  const invalidate = vi.fn();
  const registration = new NodeNativeMemberRegistration({
    teamsRoot: root,
    inbox: { sendMessage },
    invalidate,
  });
  return { registration, configPath, sendMessage, invalidate };
}

describe('native member registration before private startup delivery', () => {
  it('projects the exact owned attempt into an existing configured row, then sends a generation-specific private check', async () => {
    const { registration, configPath, sendMessage, invalidate } = await setup();
    await registration.register(
      settings,
      token,
      processIdentity,
      { eventsPath: 'TEST-events', ...proof },
      new AbortController().signal
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.members).toHaveLength(2);
    expect(config.members[1]).toMatchObject({
      name: 'builder',
      runtimePid: 101,
      bootstrapRunId: run.runId,
      bootstrapProofToken: proof.proofToken,
      bootstrapContextHash: proof.contextHash,
      backendType: 'process',
      runtimeProcessBirthId: 'TEST-birth',
      runtimeGeneration: 1,
      runtimeOperationId: 'TEST-start',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      run.teamName,
      expect.objectContaining({
        member: 'builder',
        from: 'team-lead',
        messageId: 'native-bootstrap-TEST-start',
        text: expect.stringContaining('agent_teams_native_app_managed_bootstrap_check'),
      }),
      expect.objectContaining({ shouldStillWrite: expect.any(Function) })
    );
    expect(invalidate).toHaveBeenCalledWith(run.teamName);
  });

  it('records the resolved worktree with the exact process attempt and retains its files projection on release', async () => {
    const { registration, configPath } = await setup();
    const worktree = {
      baseRepoPath: 'TEST-base',
      branchName: 'TEST-task',
    };
    await registration.register(
      { ...settings, workingDirectory: 'TEST-worktree', worktree },
      token,
      processIdentity,
      { eventsPath: 'TEST-events', ...proof },
      new AbortController().signal
    );
    expect(JSON.parse(await readFile(configPath, 'utf8')).members[1]).toMatchObject({
      cwd: 'TEST-worktree',
      worktreePath: 'TEST-worktree',
      worktreeBranch: 'TEST-task',
      worktreeGitRoot: 'TEST-base',
      worktreeBaseWorkspaceRoot: 'TEST-base',
    });
    await registration.release(token, processIdentity);
    expect(JSON.parse(await readFile(configPath, 'utf8')).members[1]).toMatchObject({
      worktreePath: 'TEST-worktree',
      worktreeBranch: 'TEST-task',
    });
  });

  it('records and releases the lead process without delivering a teammate startup check', async () => {
    const { registration, configPath, sendMessage } = await setup();
    const lead = { ...token, memberName: 'team-lead' };
    await registration.registerLead(
      { ...settings, memberName: 'team-lead', role: 'lead' },
      lead,
      processIdentity,
      new AbortController().signal
    );
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(config.members[0]).toMatchObject({
      runtimePid: processIdentity.pid,
      runtimeOperationId: lead.operationId,
    });
    expect(config.members[0].bootstrapProofToken).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    await registration.release(lead, processIdentity);
    expect(JSON.parse(await readFile(configPath, 'utf8')).members[0].runtimePid).toBeUndefined();
  });

  it('releases only the exact attempt and preserves a replacement process projection', async () => {
    const { registration, configPath } = await setup();
    await registration.register(
      settings,
      token,
      processIdentity,
      { eventsPath: 'TEST-events', ...proof },
      new AbortController().signal
    );
    const before = await readFile(configPath, 'utf8');
    await registration.release({ ...token, operationId: 'TEST-old' }, processIdentity);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    await registration.release(token, { ...processIdentity, birthId: 'TEST-old-birth' });
    expect(await readFile(configPath, 'utf8')).toBe(before);
    await registration.release(token, processIdentity);
    const member = JSON.parse(await readFile(configPath, 'utf8')).members[1];
    expect(member.runtimePid).toBeUndefined();
    expect(member.bootstrapProofToken).toBeUndefined();
    expect(member.name).toBe('builder');
    expect(member.role).toBe('TEST builder');
  });

  it('rejects another run owner and never overwrites an unreleased attempt', async () => {
    const { registration, configPath, sendMessage } = await setup();
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    saved.appManagedRun.identity.runId = 'TEST-other';
    await writeFile(configPath, JSON.stringify(saved));
    await expect(
      registration.register(
        settings,
        token,
        processIdentity,
        { eventsPath: 'TEST', ...proof },
        new AbortController().signal
      )
    ).rejects.toThrow('owner');
    saved.appManagedRun.identity.runId = run.runId;
    saved.members[1].runtimePid = 999;
    await writeFile(configPath, JSON.stringify(saved));
    const before = await readFile(configPath, 'utf8');
    await expect(
      registration.register(
        settings,
        token,
        processIdentity,
        { eventsPath: 'TEST', ...proof },
        new AbortController().signal
      )
    ).rejects.toThrow('another process');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('never appends unknown members or writes a cancelled attempt', async () => {
    const { registration, configPath, sendMessage } = await setup();
    const before = await readFile(configPath, 'utf8');
    await expect(
      registration.register(
        { ...settings, memberName: 'invented' },
        { ...token, memberName: 'invented' },
        processIdentity,
        { eventsPath: 'TEST', ...proof },
        new AbortController().signal
      )
    ).rejects.toThrow('configured');
    const abort = new AbortController();
    abort.abort();
    await expect(
      registration.register(
        settings,
        token,
        processIdentity,
        { eventsPath: 'TEST', ...proof },
        abort.signal
      )
    ).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
