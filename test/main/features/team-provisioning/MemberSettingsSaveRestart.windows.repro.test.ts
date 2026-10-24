/**
 * «Save + Restart» живого агента на Windows (спека bugfix-member-save-restart, сценарии SR-00 … SR-12, SR-15, SR-16, SR-20b).
 *
 * Что взято настоящим кодом: createTeamMemberSettingsFeature (сохранение, контракт сбоя),
 * LegacyMemberSettingsLifecycleAdapter, TeamProvisioningMemberLifecycleController.attachLiveRosterMember
 * (остановка старого процесса, статусы, запуск, определение состояния процесса при сбое),
 * createNodeStopPrimaryOwnedRosterRuntimeUseCase, inspectProcessByPid с повтором, terminateMemberProcess.
 *
 * РИСК: ОС подменена моделью, и тест не покрывает то, что она не умеет:
 *  - запуск нового процесса (launchDirectProcessMemberRestart) записывает pid в список, аргументы запуска,
 *    стартовый контекст и подтверждение запуска не проверяются (их закрывают SR-06, SR-06b и L3);
 *  - killProcessByPidAndWait смоделирован по processKill.ts: «послать taskkill /T /F, ждать исчезновения pid
 *    не дольше timeoutMs, иначе ошибка remained alive after cleanup»; настоящее дерево процессов проверяет L2
 *    (StopPrimaryOwnedRosterRuntime.windows.test.ts);
 *  - запрос PowerShell смоделирован вызовом execFile: ответ JSON, пустой ответ или ошибка таймаута; настоящий
 *    PowerShell проверяет L2;
 *  - хост контроллера задан частично (Proxy бросает ошибку на любое незаданное поле), поэтому путь, которому
 *    нужно новое поле хоста, красный, а не тихий.
 * Числа задержек взяты из замеров на машине владельца 22.10.2026 (запрос 0,6-4,3 с, дерево умирает 1,3-6 с).
 */
import { TEAM_UPDATE_MEMBER_SETTINGS } from '@features/team-provisioning/contracts';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import { registerTeamMemberSettingsIpc } from '@features/team-provisioning/main/adapters/input/registerTeamMemberSettingsIpc';
import { createTeamMemberSettingsFeature } from '@features/team-provisioning/main/composition/createTeamMemberSettingsFeature';
import { TeamProvisioningMemberLifecycleController } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateMemberSettingsRequest } from '@features/team-provisioning/contracts/memberSettings';
import type { MemberSettingsRepositoryPort } from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import type { TeamProvisioningMemberLifecycleHost } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleHostPorts';
import type { TeamProvisioningMemberLifecycleOperationUseCases } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleOperationUseCases';
import type { ProvisioningRun } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleTypes';
import type { TeamConfig } from '@shared/types';
import type { IpcMain } from 'electron';

const world = vi.hoisted(() => ({
  commands: new Map<number, string>(),
  inspectFailuresLeft: 0,
  inspectDelayMs: 0,
  inspectCalls: [] as number[],
  exitDelayMs: 0,
  unkillable: false,
  kills: [] as number[],
  killTimeouts: [] as number[],
  warnings: [] as string[],
  diagnostics: [] as string[],
  errors: [] as string[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  // Как execFile с PowerShell: ответ JSON, пустой ответ (pid нет) или ошибка таймаута (процесс убит по лимиту).
  const execFile = vi.fn(
    (
      _file: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      const pid = Number(/ProcessId=(\d+)/.exec(args.at(-1) ?? '')?.[1]);
      world.inspectCalls.push(pid);
      setTimeout(() => {
        if (world.inspectFailuresLeft > 0) {
          world.inspectFailuresLeft -= 1;
          callback(
            Object.assign(new Error('Command failed: powershell.exe'), {
              killed: true,
              signal: 'SIGTERM',
              code: null,
            }),
            '',
            ''
          );
          return;
        }
        const command = world.commands.get(pid);
        callback(null, command ? JSON.stringify({ ProcessId: pid, CommandLine: command }) : '', '');
      }, world.inspectDelayMs);
      return {} as never;
    }
  );
  return { ...actual, default: { ...actual, execFile }, execFile };
});

vi.mock('@main/utils/processKill', () => ({
  killProcessByPid: vi.fn(),
  killProcessByPidAndWait: vi.fn(async (pid: number, options?: { timeoutMs?: number }) => {
    if (!world.commands.has(pid)) {
      return;
    }
    world.kills.push(pid);
    const timeoutMs = options?.timeoutMs ?? 5_000;
    world.killTimeouts.push(timeoutMs);
    if (!world.unkillable) {
      setTimeout(() => world.commands.delete(pid), world.exitDelayMs);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(world.exitDelayMs, timeoutMs)));
    if (world.unkillable) {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    }
    if (world.commands.has(pid)) {
      throw new Error(`Process ${pid} remained alive after cleanup`);
    }
  }),
}));

vi.mock('@main/utils/processHealth', () => ({
  isProcessAlive: vi.fn((pid: number) => world.commands.has(pid)),
}));

vi.mock('@shared/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: () => undefined,
      info: () => undefined,
      error: (message: string) => {
        world.errors.push(message);
      },
      warn: (message: string) => {
        world.warnings.push(message);
      },
      diagnostic: (message: string) => {
        world.diagnostics.push(message);
      },
    }),
  };
});

vi.mock('@features/tmux-installer/main', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/tmux-installer/main')>();
  return {
    ...actual,
    killTmuxPaneForCurrentPlatformSync: vi.fn(),
    listRuntimeProcessTableForCurrentPlatform: vi.fn(async () => null),
    listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
    listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  };
});

const TEAM = 'my-team';
const MEMBER = 'DEPLOY';
const OLD_PID = 62728;
const SIBLING_PID = 62008;
const OLD_WORKFLOW = 'старый workflow';
const NEW_WORKFLOW = 'ревизия и образ равны кандидату; откат: gate.sh rollback';

function commandLine(memberName: string): string {
  return `C:\\Users\\dev\\.claude\\bin\\claude-multimodel.exe --teammate-runtime headless --agent-id ${memberName}@${TEAM} --agent-name ${memberName} --team-name ${TEAM} --agent-color blue`;
}

function snapshot(workflow: string | null): MemberSettingsTargetSnapshot {
  return {
    name: MEMBER,
    agentType: 'architect',
    agentId: `${MEMBER}@${TEAM}`,
    joinedAt: 1,
    settings: {
      role: 'architect',
      workflow,
      isolation: 'worktree',
      providerId: 'anthropic',
      providerBackendId: null,
      model: 'claude-sonnet-5-5',
      effort: null,
      fastMode: null,
      mcpPolicy: null,
    },
    teamIsAlive: true,
    leadProviderId: 'anthropic',
    teamIsMixed: false,
    runtimeLane: 'primary',
  };
}

const immediateOperationUseCases: TeamProvisioningMemberLifecycleOperationUseCases = {
  isMemberLifecycleOperationActive: () => false,
  async runMemberLifecycleOperation(_teamName, _memberName, _kind, operation) {
    return operation();
  },
};

function createHarness() {
  let current = snapshot(OLD_WORKFLOW);
  let persistedPid = OLD_PID;
  let nextPid = 70000;
  let launchFailure: Error | null = null;
  const spawned: Array<{ pid: number; workflow: string | null }> = [];
  const statuses: Array<{ status: string; error?: string }> = [];
  const restoreTarget = vi.fn(async (input: { snapshot: MemberSettingsTargetSnapshot }) => {
    current = input.snapshot;
    return true;
  });

  const config = {
    name: 'Tokenplan Ops',
    projectPath: 'E:/repos/tokenplan',
    members: [{ name: MEMBER, role: 'architect', providerId: 'anthropic' }],
  } as unknown as TeamConfig;
  const run = {
    runId: 'run-1',
    teamName: TEAM,
    request: {
      teamName: TEAM,
      cwd: 'E:/repos/tokenplan',
      providerId: 'anthropic',
      members: [{ name: MEMBER, role: 'architect', providerId: 'anthropic' }],
    },
    detectedSessionId: null,
    memberMcpConfigPaths: [],
    memberSpawnStatuses: new Map(),
    memberSpawnToolUseIds: new Map(),
    pendingMemberRestarts: new Map(),
    mixedSecondaryLanes: [],
    processKilled: false,
    cancelRequested: false,
    isLaunch: false,
    provisioningComplete: true,
  } as unknown as ProvisioningRun;

  // РИСК: поля хоста заданы вручную; незаданное поле бросает ошибку (см. шапку файла).
  const modeledHost: Partial<TeamProvisioningMemberLifecycleHost> = {
    runs: new Map([[run.runId, run]]),
    membersMetaStore: { getMembers: async () => [] } as never,
    readConfigForStrictDecision: async () => config,
    resolveEffectiveConfiguredMember: (configMembers, _metaMembers, memberName) =>
      (configMembers ?? []).find((candidate) => candidate.name === memberName) ?? null,
    resolveLeadMemberName: () => 'team-lead',
    getAliveRunId: () => run.runId,
    getTrackedRunId: () => run.runId,
    isCurrentTrackedRun: (candidate) => candidate === run,
    getLiveTeamAgentRuntimeMetadata: async () => new Map(),
    readPersistedRuntimeMembers: () => [
      { name: MEMBER, backendType: 'process', runtimePid: persistedPid },
    ],
    invalidateRuntimeSnapshotCaches: () => undefined,
    resetRuntimeToolActivity: () => undefined,
    clearMemberSpawnToolTracking: () => undefined,
    appendMemberBootstrapDiagnostic: () => undefined,
    setMemberSpawnStatus: (_run, _memberName, status, error) => {
      statuses.push({ status, ...(error ? { error } : {}) });
    },
  };
  const host = new Proxy(modeledHost, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }
      throw new Error(`The test host does not model "${String(property)}"`);
    },
  }) as TeamProvisioningMemberLifecycleHost;

  const controller = new TeamProvisioningMemberLifecycleController(
    host,
    immediateOperationUseCases,
    {
      restart: {
        // РИСК: запуск нового процесса — запись pid в список; аргументы, контекст и подтверждение не проверяются.
        async launchDirectProcessMemberRestart() {
          if (launchFailure) {
            throw launchFailure;
          }
          const pid = nextPid++;
          world.commands.set(pid, commandLine(MEMBER));
          persistedPid = pid;
          spawned.push({ pid, workflow: current.settings.workflow });
        },
      },
    }
  );

  const repository: MemberSettingsRepositoryPort = {
    findTarget: async () => current,
    classifyMissingTarget: async () => 'member_not_found',
    applyTarget: async (input) => {
      current = { ...current, settings: input.settings };
      return { outcome: 'applied', snapshot: current, rollbackToken: 'rollback-1' };
    },
    restoreTarget,
  };

  const feature = createTeamMemberSettingsFeature({
    repository,
    mutationSource: { runLiveRosterMutation: async (_team, operation) => operation() },
    lifecycleSource: {
      isTeamAlive: () => true,
      attachLiveRosterMember: (teamName, memberName, options) =>
        controller.attachLiveRosterMember(teamName, memberName, options),
    },
  });

  function request(): UpdateMemberSettingsRequest {
    return {
      commandId: `command-${Math.random()}`,
      idempotencyKey: `idem-${Math.random()}`,
      teamName: TEAM,
      memberName: MEMBER,
      expectedFingerprint: createMemberSettingsFingerprint(current),
      targetKind: 'member',
      settings: { ...current.settings, workflow: NEW_WORKFLOW },
    };
  }

  const ipcHandlers = new Map<string, (event: unknown, value: unknown) => Promise<unknown>>();
  registerTeamMemberSettingsIpc(
    {
      handle: (channel: string, handler: (event: unknown, value: unknown) => Promise<unknown>) => {
        ipcHandlers.set(channel, handler);
      },
      removeHandler: () => undefined,
    } as unknown as IpcMain,
    feature
  );

  async function save() {
    return drive(() => feature.updateMemberSettings(request()));
  }

  /** Same command through the IPC handler the renderer calls: `{ success, data | error }`. */
  async function saveViaIpc() {
    return drive(
      () =>
        ipcHandlers.get(TEAM_UPDATE_MEMBER_SETTINGS)!(null, request()) as Promise<{
          success: boolean;
          data?: unknown;
          error?: string;
        }>
    );
  }

  /** The «Restart» button of the member card: no settings change, the same stop and launch. */
  async function restartManually() {
    return drive(() => controller.restartMember(TEAM, MEMBER));
  }

  async function drive<T>(operation: () => Promise<T>) {
    const startedAt = Date.now();
    const settled = operation().then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error })
    );
    let done = false;
    void settled.finally(() => {
      done = true;
    });
    for (let i = 0; i < 600 && !done; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
    }
    const outcome = await settled;
    const elapsedMs = Date.now() - startedAt;
    // Дать дереву, которому послан taskkill, дожить до конца: состояние считается после выхода процесса.
    await vi.advanceTimersByTimeAsync(10_000);
    return { ...outcome, elapsedMs };
  }

  return {
    save,
    saveViaIpc,
    restartManually,
    spawned,
    statuses,
    restoreTarget,
    failLaunchWith: (error: Error) => {
      launchFailure = error;
    },
    storedWorkflow: () => current.settings.workflow,
    isOldProcessAlive: () => world.commands.has(OLD_PID),
    aliveMemberProcesses: () =>
      [...world.commands.entries()].filter(([, command]) =>
        command.includes(`--agent-name ${MEMBER} `)
      ).length,
  };
}

describe.skipIf(process.platform !== 'win32')('Save + Restart живого агента на Windows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    world.commands.clear();
    world.commands.set(OLD_PID, commandLine(MEMBER));
    world.commands.set(SIBLING_PID, commandLine('REVIWER'));
    world.inspectFailuresLeft = 0;
    world.inspectDelayMs = 0;
    world.inspectCalls.length = 0;
    world.exitDelayMs = 0;
    world.unkillable = false;
    world.kills.length = 0;
    world.killTimeouts.length = 0;
    world.warnings.length = 0;
    world.diagnostics.length = 0;
    world.errors.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SR-00 контроль: быстрое чтение и мгновенный выход — Save + Restart проходит', async () => {
    const harness = createHarness();

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.spawned).toEqual([{ pid: expect.any(Number), workflow: NEW_WORKFLOW }]);
    expect(harness.isOldProcessAlive()).toBe(false);
    expect(world.kills).toEqual([OLD_PID]);
    expect(world.commands.has(SIBLING_PID)).toBe(true);
  });

  it('SR-01 первое чтение процесса не уложилось — проверка повторена, перезапуск прошёл', async () => {
    world.inspectFailuresLeft = 1;
    const harness = createHarness();

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.spawned.at(-1)?.workflow).toBe(NEW_WORKFLOW);
    expect(world.inspectCalls).toEqual([OLD_PID, OLD_PID]);
    expect(world.diagnostics).toContainEqual(
      expect.stringContaining(
        `Lookup of teammate process pid=${OLD_PID} was unreadable (attempt 1)`
      )
    );
  });

  it('SR-02 «не смог прочитать» не выдаётся за «процесс чужой»: результат со сбоем, процесс жив, настройки сохранены', async () => {
    world.inspectFailuresLeft = 4;
    const harness = createHarness();

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      outcome: 'completed',
      effect: 'member_restart_failed',
      failure: { memberProcess: 'running' },
    });
    const cause = (result as { failure: { cause: string } }).failure.cause;
    expect(cause).toContain('the process list could not be read');
    expect(cause).toContain('windows_process_inspection');
    expect(world.warnings.some((line) => line.includes('process identity does not match'))).toBe(
      false
    );
    expect(world.kills).toEqual([]);
    expect(harness.isOldProcessAlive()).toBe(true);
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
  });

  it('SR-03 сбой остановки не вызывает второго перезапуска и отката настроек', async () => {
    world.inspectFailuresLeft = 4;
    const harness = createHarness();

    await harness.save();

    expect(harness.restoreTarget).not.toHaveBeenCalled();
    expect(world.kills).toEqual([]);
    expect(harness.spawned).toEqual([]);
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
  });

  it('SR-04 дерево процессов умирает 3 с — остановка дожидается, перезапуск завершается', async () => {
    world.exitDelayMs = 3_000;
    const harness = createHarness();

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.aliveMemberProcesses()).toBe(1);
    expect(world.killTimeouts).toEqual([20_000]);
  });

  it('SR-05 инцидент 22.10: первое чтение не уложилось, процесс умирает 4 с — агент не остаётся без процесса', async () => {
    world.inspectFailuresLeft = 1;
    world.exitDelayMs = 4_000;
    const harness = createHarness();

    const { result } = await harness.save();

    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(harness.aliveMemberProcesses()).toBe(1);
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.spawned.at(-1)?.workflow).toBe(NEW_WORKFLOW);
    expect(world.kills).toEqual([OLD_PID]);
  });

  it('SR-09 контроль: агент уже мёртв — kill не вызывался, запущен один новый процесс', async () => {
    world.commands.delete(OLD_PID);
    const harness = createHarness();

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ outcome: 'completed', effect: 'member_restart_started' });
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.spawned).toEqual([{ pid: expect.any(Number), workflow: NEW_WORKFLOW }]);
    expect(world.kills).toEqual([]);
  });

  it('SR-10 запуск не удался после успешной остановки: сбой с процессом «остановлен», запуск один, статус error', async () => {
    const harness = createHarness();
    harness.failLaunchWith(new Error('spawn failed: ENOENT'));

    const { result, error } = await harness.save();

    expect(error).toBeUndefined();
    expect(result).toMatchObject({
      outcome: 'completed',
      effect: 'member_restart_failed',
      failure: { cause: 'spawn failed: ENOENT', memberProcess: 'stopped' },
    });
    expect(harness.spawned).toEqual([]);
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
    expect(harness.restoreTarget).not.toHaveBeenCalled();
    expect(world.kills).toEqual([OLD_PID]);
    expect(harness.isOldProcessAlive()).toBe(false);
    expect(harness.statuses).toContainEqual({ status: 'error', error: 'spawn failed: ENOENT' });
    expect(harness.statuses.filter((entry) => entry.status === 'spawning')).toHaveLength(1);
  });

  it('SR-11 под pid участника чужой процесс: kill не вызывался, сбой называет причину, процесс остаётся', async () => {
    world.commands.set(OLD_PID, 'C:\\Windows\\System32\\notepad.exe');
    const harness = createHarness();

    const { result } = await harness.save();

    expect(result).toMatchObject({
      outcome: 'completed',
      effect: 'member_restart_failed',
      failure: { memberProcess: 'running' },
    });
    expect((result as { failure: { cause: string } }).failure.cause).toContain(
      'the process is not the runtime of this teammate'
    );
    expect(world.kills).toEqual([]);
    expect(harness.spawned).toEqual([]);
    expect(world.warnings.some((line) => line.includes('process identity does not match'))).toBe(
      true
    );
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
  });

  it('SR-12 соседи не затронуты: kill только для pid участника, сосед жив', async () => {
    world.exitDelayMs = 2_000;
    const harness = createHarness();

    await harness.save();

    expect(world.kills).toEqual([OLD_PID]);
    expect(world.commands.has(SIBLING_PID)).toBe(true);
    expect(harness.statuses.every((entry) => entry.status !== 'online')).toBe(true);
  });

  it('SR-20b предел ожидания: pid не исчезает — через 20 с сбой «процесс запущен», запуска нет, настройки сохранены', async () => {
    world.unkillable = true;
    const harness = createHarness();

    const { result, elapsedMs } = await harness.save();

    expect(result).toMatchObject({
      outcome: 'completed',
      effect: 'member_restart_failed',
      failure: { memberProcess: 'running' },
    });
    expect((result as { failure: { cause: string } }).failure.cause).toContain(
      `pid ${OLD_PID}: Process ${OLD_PID} remained alive after cleanup`
    );
    expect(elapsedMs).toBeGreaterThanOrEqual(20_000);
    expect(elapsedMs).toBeLessThan(25_000);
    expect(world.killTimeouts).toEqual([20_000]);
    expect(harness.spawned).toEqual([]);
    expect(harness.storedWorkflow()).toBe(NEW_WORKFLOW);
  });

  it('SR-16 журнал: успешный перезапуск пишет этапы по порядку — приём, личность, остановка, запуск, исход', async () => {
    const harness = createHarness();

    const { result } = await harness.saveViaIpc();

    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'completed', effect: 'member_restart_started' },
    });
    const stages = [
      /^Member settings update accepted: team=my-team member=DEPLOY command=command-[\d.]+ target=member$/,
      new RegExp(
        `^\\[my-team\\] Update for teammate "DEPLOY": identity of pid=${OLD_PID} is found$`
      ),
      new RegExp(
        `^\\[my-team\\] Update for teammate "DEPLOY": stopped pid=${OLD_PID} in \\d+ ms$`
      ),
      /^\[my-team\] Launching teammate "DEPLOY" \(member_updated\)$/,
      /^\[my-team\] Launched teammate "DEPLOY" \(member_updated\) in \d+ ms$/,
      /^Member settings update finished: team=my-team member=DEPLOY command=command-[\d.]+ target=member outcome=completed effect=member_restart_started replayed=false$/,
    ];
    let from = 0;
    for (const stage of stages) {
      const index = world.diagnostics.findIndex((line, i) => i >= from && stage.test(line));
      expect(index, `нет строки журнала ${stage}`).toBeGreaterThanOrEqual(from);
      from = index + 1;
    }
    expect(world.warnings).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it('SR-16 журнал: сбой запуска попадает в журнал с причиной и состоянием процесса', async () => {
    const harness = createHarness();
    harness.failLaunchWith(new Error('spawn failed: ENOENT'));

    const { result } = await harness.saveViaIpc();

    expect(result).toMatchObject({
      success: true,
      data: { effect: 'member_restart_failed', failure: { cause: 'spawn failed: ENOENT' } },
    });
    expect(world.diagnostics).toContainEqual(
      expect.stringMatching(
        /^\[my-team\] Launch of teammate "DEPLOY" \(member_updated\) failed after \d+ ms: spawn failed: ENOENT$/
      )
    );
    expect(world.diagnostics).toContain(
      '[my-team] Restart of teammate "DEPLOY" failed, process is stopped: spawn failed: ENOENT'
    );
    expect(world.warnings).toEqual([
      expect.stringMatching(
        /^Member settings update finished: team=my-team member=DEPLOY command=command-[\d.]+ target=member outcome=completed effect=member_restart_failed replayed=false memberProcess=stopped cause=spawn failed: ENOENT$/
      ),
    ]);
    expect(world.errors).toEqual([]);
  });

  it('SR-15а ручной «Restart» живого агента: дерево умирает 3 с, первое чтение не уложилось — те же операции, как у Save', async () => {
    world.exitDelayMs = 3_000;
    world.inspectFailuresLeft = 1;
    const harness = createHarness();

    const { error, elapsedMs } = await harness.restartManually();

    expect(error).toBeUndefined();
    expect(world.inspectCalls).toEqual([OLD_PID, OLD_PID]);
    expect(world.kills).toEqual([OLD_PID]);
    expect(world.killTimeouts).toEqual([20_000]);
    expect(elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(harness.spawned).toEqual([{ pid: expect.any(Number), workflow: OLD_WORKFLOW }]);
    expect(harness.aliveMemberProcesses()).toBe(1);
    expect(harness.isOldProcessAlive()).toBe(false);
    expect(world.commands.has(SIBLING_PID)).toBe(true);
  });

  it('SR-15б ручной «Restart» мёртвого агента: kill не вызывался, процесс запускается сразу', async () => {
    world.commands.delete(OLD_PID);
    const harness = createHarness();

    const { error, elapsedMs } = await harness.restartManually();

    expect(error).toBeUndefined();
    expect(world.kills).toEqual([]);
    expect(harness.spawned).toEqual([{ pid: expect.any(Number), workflow: OLD_WORKFLOW }]);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('SR-15в ручной «Restart»: процесс не уходит за 20 с — ошибка с настоящей причиной, запуска нет', async () => {
    world.unkillable = true;
    const harness = createHarness();

    const { error } = await harness.restartManually();

    expect(String((error as Error | undefined)?.message)).toContain(
      `Process ${OLD_PID} remained alive after cleanup`
    );
    expect(harness.spawned).toEqual([]);
    expect(harness.isOldProcessAlive()).toBe(true);
  });

  it('SR-15г ручной «Restart»: под pid участника чужой процесс — kill не вызывался, чужой процесс жив, запущен один новый, в журнале причина', async () => {
    world.commands.set(OLD_PID, commandLine('REVIWER'));
    const harness = createHarness();

    const { error } = await harness.restartManually();

    expect(error).toBeUndefined();
    expect(world.kills).toEqual([]);
    expect(world.commands.get(OLD_PID)).toBe(commandLine('REVIWER'));
    expect(harness.spawned).toEqual([{ pid: expect.any(Number), workflow: OLD_WORKFLOW }]);
    expect(world.warnings).toContainEqual(
      expect.stringContaining(`Ignoring persisted pid=${OLD_PID} for ${MEMBER} on manual restart`)
    );
  });
});
