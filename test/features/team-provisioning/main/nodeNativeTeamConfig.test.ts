// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodeNativeTeamConfig } from '../../../../src/features/team-provisioning/main/adapters/output/NodeNativeTeamConfig';
import { NodeTeamLaunchSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamLaunchSettings';
import { inspectProcessByPid } from '../../../../src/main/utils/processInspection';

vi.mock('../../../../src/main/utils/processInspection', () => ({
  inspectProcessByPid: vi.fn(),
  // The production path takes one roster snapshot; tests keep controlling the
  // per-pid outcomes, so the batch simply delegates to them.
  inspectProcessesByPid: vi.fn(async (pids: readonly number[]) => {
    const { inspectProcessByPid } = await import('../../../../src/main/utils/processInspection');
    const map = new Map<number, unknown>();
    for (const pid of pids) map.set(pid, await (inspectProcessByPid as unknown as (pid: number) => Promise<unknown>)(pid));
    return map;
  }),
}));

const directories: string[] = [];
const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-config-team',
  runId: 'TEST-run',
};

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-team-config-'));
  directories.push(root);
  const teamDirectory = join(root, run.teamName);
  await mkdir(teamDirectory);
  const meta = {
    version: 1 as const,
    providerId: 'anthropic' as const,
    cwd: root,
    model: 'TEST-model',
    effort: 'high',
    description: 'TEST description',
    createdAt: 10,
  };
  const membersMeta = {
    version: 1 as const,
    members: [
      { name: 'builder', role: 'TEST builder', color: 'blue', joinedAt: 20 },
      { name: 'removed', removedAt: 30 },
    ],
  };
  const settings = new NodeTeamLaunchSettings({
    teamsRoot: root,
    metadata: {
      async getMeta() {
        return meta;
      },
    },
    members: {
      async getMeta() {
        return membersMeta;
      },
    },
  });
  await settings.capture(run);
  const config = new NodeNativeTeamConfig({ teamsRoot: root, settings, invalidate() {} });
  const configPath = join(teamDirectory, 'config.json');
  return { root, meta, membersMeta, settings, config, configPath, teamDirectory };
}

async function readConfig(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('app-owned native team runtime configuration', () => {
  it('materializes the saved roster before any CLI starts, without TeamCreate or invented members', async () => {
    const { config, configPath, root } = await setup();
    await config.prepare(run, new AbortController().signal);
    const saved = await readConfig(configPath);
    expect(saved).toMatchObject({
      name: run.teamName,
      createdAt: 10,
      description: 'TEST description',
      leadAgentId: `team-lead@${run.teamName}`,
      appManagedRun: { identity: run },
    });
    expect(saved.members.map((member: { name: string }) => member.name)).toEqual([
      'team-lead',
      'builder',
    ]);
    expect(saved.members[0]).toMatchObject({
      agentType: 'team-lead',
      cwd: root,
      provider: 'anthropic',
      model: 'TEST-model',
      effort: 'high',
      joinedAt: 10,
      subscriptions: [],
    });
    expect(saved.members[1]).toMatchObject({
      agentId: `builder@${run.teamName}`,
      cwd: root,
      color: 'blue',
      joinedAt: 20,
      subscriptions: [],
    });
    expect(
      saved.members.every((member: object) => !('runtimePid' in member) && !('isActive' in member))
    ).toBe(true);
    expect(saved.leadSessionId).toBeUndefined();
  });

  it('adds one configured member to a live projection without rewriting the roster', async () => {
    const { config, configPath, membersMeta, settings } = await setup();
    await config.prepare(run, new AbortController().signal);
    membersMeta.members.push({ name: 'tester', color: 'green', joinedAt: 40 } as never);
    await settings.admitConfiguredMember(run, 'tester');
    const launch = await settings.findConfiguredMember(run, 'tester');
    expect(launch).not.toBeNull();
    await config.addMember(run, launch!);
    const saved = await readConfig(configPath);
    expect(saved.members.map((member: { name: string }) => member.name)).toEqual([
      'team-lead',
      'builder',
      'tester',
    ]);
    expect(saved.leadAgentId).toBe(`team-lead@${run.teamName}`);
    expect(saved.appManagedRun.configurationRevision).toBe(launch!.configurationRevision);
    expect(
      saved.members.find((member: { name: string }) => member.name === 'tester')
    ).toMatchObject({
      agentId: `tester@${run.teamName}`,
      color: 'green',
      joinedAt: 40,
    });
  });

  it('updates an existing row without dropping its live runtime projection', async () => {
    const { config, configPath, membersMeta, settings } = await setup();
    await config.prepare(run, new AbortController().signal);
    membersMeta.members.push({ name: 'tester', color: 'green', joinedAt: 40 } as never);
    await settings.admitConfiguredMember(run, 'tester');
    await config.addMember(run, (await settings.findConfiguredMember(run, 'tester'))!);
    const written = await readConfig(configPath);
    const tester = written.members.find((member: { name: string }) => member.name === 'tester');
    tester.runtimePid = 4242;
    tester.sessionId = 'TEST-session';
    await writeFile(configPath, JSON.stringify(written));
    const changed = membersMeta.members.find((member) => member.name === 'tester') as {
      role?: string;
    };
    changed.role = 'TEST updated role';
    await settings.admitConfiguredMember(run, 'tester');
    await config.addMember(run, (await settings.findConfiguredMember(run, 'tester'))!);
    const saved = await readConfig(configPath);
    const updated = saved.members.find((member: { name: string }) => member.name === 'tester');
    expect(updated).toMatchObject({
      runtimePid: 4242,
      sessionId: 'TEST-session',
    });
    expect(updated.prompt).toContain('TEST updated role');
    expect(saved.members).toHaveLength(3);
  });

  it('rejects attaching the lead or a member from another run', async () => {
    const { config, settings } = await setup();
    await config.prepare(run, new AbortController().signal);
    const member = (await settings.findConfiguredMember(run, 'builder'))!;
    await expect(config.addMember(run, { ...member, role: 'lead' })).rejects.toThrow(
      'Lead attach is not supported'
    );
    await expect(
      config.addMember(run, { ...member, team: { ...member.team, runId: 'OTHER-run' } })
    ).rejects.toThrow('does not belong to this run');
  });

  it('materializes a configured Gemini lead and member without rewriting their provider selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-gemini-config-'));
    directories.push(root);
    await mkdir(join(root, run.teamName));
    const settings = new NodeTeamLaunchSettings({
      teamsRoot: root,
      metadata: {
        async getMeta() {
          return {
            version: 1,
            providerId: 'gemini',
            model: 'TEST-gemini-model',
            cwd: root,
            createdAt: 1,
          };
        },
      },
      members: {
        async getMeta() {
          return { version: 1, members: [{ name: 'builder' }] };
        },
      },
    });
    await settings.capture(run);
    const config = new NodeNativeTeamConfig({ teamsRoot: root, settings, invalidate() {} });
    await config.prepare(run, new AbortController().signal);
    expect((await readConfig(join(root, run.teamName, 'config.json'))).members).toEqual([
      expect.objectContaining({
        name: 'team-lead',
        provider: 'gemini',
        model: 'TEST-gemini-model',
      }),
      expect.objectContaining({ name: 'builder', provider: 'gemini', model: 'TEST-gemini-model' }),
    ]);
    await config.release(run);
  });

  it('preserves durable history and idempotently leaves the current run runtime evidence untouched', async () => {
    const { config, configPath } = await setup();
    await writeFile(
      configPath,
      JSON.stringify({
        name: run.teamName,
        createdAt: 1,
        sessionHistory: ['TEST-history'],
        projectPathHistory: ['TEST-project'],
        members: [{ name: 'builder', subscriptions: ['TEST-topic'], customNote: 'TEST-note' }],
      })
    );
    await config.prepare(run, new AbortController().signal);
    const saved = await readConfig(configPath);
    expect(saved.sessionHistory).toEqual(['TEST-history']);
    expect(saved.projectPathHistory).toEqual(['TEST-project']);
    expect(saved.members[1]).toMatchObject({
      subscriptions: ['TEST-topic'],
      customNote: 'TEST-note',
    });
    saved.members[1].runtimePid = process.pid;
    saved.members[1].bootstrapProofToken = 'TEST-current-proof';
    await writeFile(configPath, JSON.stringify(saved));
    const before = await readFile(configPath, 'utf8');
    await config.prepare(run, new AbortController().signal);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    await expect(
      config.prepare({ ...run, runId: 'TEST-other' }, new AbortController().signal)
    ).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it.each([
    { status: 'not_found' as const },
    { status: 'found' as const, command: 'C:\\Windows\\SystemApps\\LockApp.exe' },
  ])('launches a stopped legacy roster when its old process is $status', async (inspection) => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue(inspection);
    await writeFile(
      configPath,
      JSON.stringify({
        name: run.teamName,
        leadSessionId: 'TEST-old-session',
        sessionHistory: ['TEST-history'],
        members: [
          {
            name: 'builder',
            agentId: `builder@${run.teamName}`,
            provider: 'codex',
            runtimePid: 4242,
            tmuxPaneId: 'process:4242',
            backendType: 'process',
            bootstrapRunId: 'TEST-old-run',
            customNote: 'TEST-retained',
            subscriptions: ['TEST-topic'],
          },
        ],
      })
    );

    await config.prepare(run, new AbortController().signal);

    const saved = await readConfig(configPath);
    expect(saved.appManagedRun.identity).toEqual(run);
    expect(saved.sessionHistory).toEqual(['TEST-history']);
    expect(
      saved.members.find((member: { name: string }) => member.name === 'builder')
    ).toMatchObject({
      customNote: 'TEST-retained',
      subscriptions: ['TEST-topic'],
      provider: 'anthropic',
    });
    expect(saved.members[1].runtimePid).toBeUndefined();
    expect(saved.members[1].bootstrapRunId).toBeUndefined();
    expect(saved.members[1].tmuxPaneId).toBe('');
  });

  it.each([
    { status: 'unreadable' as const, cause: 'TEST access denied' },
    { status: 'found' as const, command: '' },
    {
      status: 'found' as const,
      command: `claude-multimodel --team-name "${run.teamName}" --agent-id builder@${run.teamName}`,
    },
    {
      status: 'found' as const,
      command: `claude-multimodel --agent-id "builder@${run.teamName}"`,
    },
    {
      status: 'found' as const,
      command: 'claude-multimodel --team-name other-team --agent-id builder@other-team',
    },
  ])('preserves legacy process evidence when inspection is $status', async (inspection) => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue(inspection);
    const before = JSON.stringify({
      name: run.teamName,
      members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242' }],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');

    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('releases a native row whose recorded pid now belongs to an unrelated process', async () => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue({
      status: 'found',
      command: 'bun unrelated-native-host.mjs E:\\tmp\\other',
    });
    await writeFile(
      configPath,
      JSON.stringify({
        name: run.teamName,
        members: [
          {
            name: 'builder',
            runtimePid: 61064,
            runtimeProcessBirthId: 'TEST-birth',
            runtimeOperationId: 'TEST-operation',
            tmuxPaneId: 'process:61064',
          },
        ],
      })
    );

    await expect(config.prepare(run, new AbortController().signal)).resolves.toBeUndefined();
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      members: Record<string, unknown>[];
    };
    expect(saved.members[0]?.runtimePid).toBeUndefined();
    expect(saved.members[0]?.runtimeProcessBirthId).toBeUndefined();
  });

  it('releases a native row whose process started long before the recorded launch', async () => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue({
      status: 'found',
      command: 'C:\\Windows\\System32\\notepad.exe',
      startedAt: Date.now() - 3_600_000,
    });
    await writeFile(
      configPath,
      JSON.stringify({
        name: run.teamName,
        members: [
          {
            name: 'builder',
            runtimePid: 4242,
            runtimeProcessBirthId: 'TEST-birth',
            runtimeOperationId: 'TEST-operation',
            runtimeStartedAt: Date.now() - 5_000,
            tmuxPaneId: 'process:4242',
          },
        ],
      })
    );

    await expect(config.prepare(run, new AbortController().signal)).resolves.toBeUndefined();
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      members: Record<string, unknown>[];
    };
    expect(saved.members[0]?.runtimePid).toBeUndefined();
    expect(saved.members[0]?.runtimeStartedAt).toBeUndefined();
  });

  it('keeps the row when the live process started after the recorded launch', async () => {
    const { config, configPath } = await setup();
    const recordedStart = Date.now() - 30_000;
    vi.mocked(inspectProcessByPid).mockResolvedValue({
      status: 'found',
      command: 'claude-multimodel --print',
      startedAt: recordedStart + 1_000,
    });
    const before = JSON.stringify({
      name: run.teamName,
      members: [
        {
          name: 'builder',
          runtimePid: 4242,
          runtimeProcessBirthId: 'TEST-birth',
          runtimeOperationId: 'TEST-operation',
          runtimeStartedAt: recordedStart,
          tmuxPaneId: 'process:4242',
        },
      ],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('keeps a live Windows shell-wrapper process whose ownership flags are caret-escaped', async () => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue({
      status: 'found',
      command: `C:\\Windows\\System32\\cmd.exe /d /s /c "^"--team-name^" ^"${run.teamName}^" ^"--agent-id^" ^"builder@${run.teamName}^""`,
    });
    const before = JSON.stringify({
      name: run.teamName,
      members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242' }],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');

    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('does not publish a partial cleanup when another legacy member is still alive', async () => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid)
      .mockResolvedValueOnce({ status: 'not_found' })
      .mockResolvedValueOnce({
        status: 'found',
        command: `claude-multimodel --team-name=${run.teamName} --agent-id other@${run.teamName}`,
      });
    const before = JSON.stringify({
      name: run.teamName,
      members: [
        { name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242' },
        { name: 'other', runtimePid: 4243, tmuxPaneId: 'process:4243' },
      ],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');

    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it.each([{ runtimeProcessBirthId: 'TEST-native-birth' }, { runtimeOperationId: 'TEST-native-operation' }])(
    'releases a native row whose recorded process is gone %j',
    async (identity) => {
      const { config, configPath } = await setup();
      vi.mocked(inspectProcessByPid).mockResolvedValue({ status: 'not_found' });
      await writeFile(
        configPath,
        JSON.stringify({
          name: run.teamName,
          members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242', ...identity }],
        })
      );

      await expect(config.prepare(run, new AbortController().signal)).resolves.toBeUndefined();
      const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
        members: Record<string, unknown>[];
      };
      expect(saved.members[0]?.runtimePid).toBeUndefined();
      expect(saved.members[0]?.runtimeProcessBirthId).toBeUndefined();
      expect(saved.members[0]?.runtimeOperationId).toBeUndefined();
    }
  );

  it.each([{ laneId: 'TEST-opencode-lane' }, { provider: 'opencode' }])(
    'does not recover non-legacy lane identity %j',
    async (identity) => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue({ status: 'not_found' });
    const before = JSON.stringify({
      name: run.teamName,
      members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242', ...identity }],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');

    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('preserves the config when cancellation arrives during process inspection', async () => {
    const { config, configPath } = await setup();
    const abort = new AbortController();
    vi.mocked(inspectProcessByPid).mockImplementation(async () => {
      abort.abort(new Error('TEST launch cancelled'));
      return { status: 'not_found' };
    });
    const before = JSON.stringify({
      name: run.teamName,
      members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242' }],
    });
    await writeFile(configPath, before);

    await expect(config.prepare(run, abort.signal)).rejects.toThrow('TEST launch cancelled');

    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('preserves a concurrent config update made while the old process is inspected', async () => {
    const { config, configPath } = await setup();
    const original = {
      name: run.teamName,
      members: [{ name: 'builder', runtimePid: 4242, tmuxPaneId: 'process:4242' }],
    };
    const concurrent = JSON.stringify({ ...original, description: 'TEST external update' });
    await writeFile(configPath, JSON.stringify(original));
    vi.mocked(inspectProcessByPid).mockImplementation(async () => {
      await writeFile(configPath, concurrent);
      return { status: 'not_found' };
    });

    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow(
      'config changed during publication'
    );

    expect(await readFile(configPath, 'utf8')).toBe(concurrent);
  });

  it('refuses an unowned process projection whose PID is alive and leaves it untouched', async () => {
    const { config, configPath } = await setup();
    vi.mocked(inspectProcessByPid).mockResolvedValue({ status: 'found', command: 'TEST agent' });
    const before = JSON.stringify({
      name: run.teamName,
      members: [
        { name: 'builder', runtimePid: process.pid, runtimeProcessBirthId: 'TEST-foreign' },
      ],
    });
    await writeFile(configPath, before);
    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('unreleased');
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('releases only an exact run claim and never erases a registered process or history', async () => {
    const { config, configPath } = await setup();
    await config.prepare(run, new AbortController().signal);
    const before = await readFile(configPath, 'utf8');
    await expect(config.release({ ...run, runId: 'TEST-stale' })).rejects.toThrow('owner');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    const saved = await readConfig(configPath);
    saved.members[1].runtimePid = process.pid;
    await writeFile(configPath, JSON.stringify(saved));
    await expect(config.release(run)).rejects.toThrow('unreleased');
    delete saved.members[1].runtimePid;
    await writeFile(configPath, JSON.stringify(saved));
    await config.release(run);
    expect((await readConfig(configPath)).appManagedRun).toBeUndefined();
    expect((await readConfig(configPath)).members).toHaveLength(2);
  });

  it('waits for the pinned CLI config lock and cancels without writing or removing that lock', async () => {
    const { config, configPath, teamDirectory } = await setup();
    const lock = join(teamDirectory, '.config.lock');
    await mkdir(lock);
    await writeFile(
      join(lock, 'metadata.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() })
    );
    const abort = new AbortController();
    const pending = config.prepare(run, abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    abort.abort(new Error('TEST cancelled'));
    await rejected;
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(lock, 'metadata.json'), 'utf8')).pid).toBe(process.pid);
    await rm(lock, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await config.prepare(run, new AbortController().signal);
    expect((await readConfig(configPath)).name).toBe(run.teamName);
  });

  it('refuses redirected team directories and preserves the target data', async () => {
    const { config, root, teamDirectory } = await setup();
    const target = join(root, 'TEST-foreign-directory');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'TEST keep');
    await rm(teamDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await symlink(target, teamDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(config.prepare(run, new AbortController().signal)).rejects.toThrow('directory');
    expect(await readFile(join(target, 'keep.txt'), 'utf8')).toBe('TEST keep');
    await expect(readFile(join(target, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
