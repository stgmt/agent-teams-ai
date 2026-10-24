import { describe, expect, it, vi } from 'vitest';

import {
  handleProvisioningProcessExit,
  type TeamProvisioningProcessExitPorts,
  type TeamProvisioningProcessExitRun,
} from '../TeamProvisioningProcessExit';

import type { TeamProvisioningProgress } from '@shared/types';

function progress(state: TeamProvisioningProgress['state'] = 'ready'): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'my-team',
    state,
    message: 'Ready',
    startedAt: '2026-10-24T05:00:00.000Z',
    updatedAt: '2026-10-24T05:00:01.000Z',
  };
}

function makeRun(
  overrides: Partial<TeamProvisioningProcessExitRun> = {}
): TeamProvisioningProcessExitRun {
  // РИСК: объект сужен до полей, которые читает ветка завершённого запуска
  // (`provisioningComplete = true`); остальные поля CliExitPresentationRun здесь не читаются.
  return {
    runId: 'run-1',
    teamName: 'my-team',
    progress: progress(),
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: true,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    provisioningComplete: true,
    processClosed: false,
    authRetryInProgress: false,
    isLaunch: true,
    onProgress: vi.fn(),
    ...overrides,
  } as unknown as TeamProvisioningProcessExitRun;
}

function makePorts(): TeamProvisioningProcessExitPorts<TeamProvisioningProcessExitRun> {
  return {
    logger: { info: vi.fn(), warn: vi.fn() },
    buildStdoutCarryDiagnostic: vi.fn(() => ({})),
    flushStdoutParserCarry: vi.fn(),
    stopStallWatchdog: vi.fn(),
    hasSecondaryRuntimeRuns: vi.fn(() => false),
    stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
    getTeamsBasePath: vi.fn(() => '/teams'),
    getAutoDetectedClaudeBasePath: vi.fn(() => '/claude'),
    getConfiguredCliCommandLabel: vi.fn(() => 'claude'),
    getRunRuntimeFailureLabel: vi.fn(() => 'runtime'),
    getVerificationTimeoutMs: vi.fn(() => 1000),
    extractCliLogsFromRun: vi.fn(() => 'last cli line'),
    logsSuggestShutdownOrCleanup: vi.fn(() => false),
    finalizeIncompleteLaunchStateBeforeCleanup: vi.fn(async () => undefined),
    waitForValidConfig: vi.fn(async () => ({ ok: false as const })),
    waitForTeamInList: vi.fn(async () => false),
    waitForMissingInboxes: vi.fn(async () => []),
    persistMembersMeta: vi.fn(async () => undefined),
    updateProgress: vi.fn(
      (
        run: TeamProvisioningProcessExitRun,
        state: Exclude<TeamProvisioningProgress['state'], 'idle'>,
        message: string,
        extras?: Partial<TeamProvisioningProgress>
      ): TeamProvisioningProgress => ({ ...run.progress, state, message, ...extras })
    ),
    cleanupRun: vi.fn(),
  };
}

describe('handleProvisioningProcessExit: typed disconnect reason', () => {
  it.each([
    { code: 1, exitCode: 1 },
    { code: 137, exitCode: 137 },
  ])(
    'NM-S01: reports process_exit with code $code and warns in the log',
    async ({ code, exitCode }) => {
      const run = makeRun();
      const ports = makePorts();

      await handleProvisioningProcessExit(run, code, ports);

      expect(ports.updateProgress).toHaveBeenCalledWith(
        run,
        'disconnected',
        `Team process exited unexpectedly (code ${code})`,
        expect.objectContaining({
          disconnect: { kind: 'process_exit', exitCode },
          cliLogsTail: 'last cli line',
        })
      );
      expect(ports.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(`[my-team] Team process exited unexpectedly (code ${code})`)
      );
      expect(ports.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('exited'));
    }
  );

  it('NM-S02: a normal exit with code 0 keeps exitCode 0 and stays an info log line', async () => {
    const run = makeRun();
    const ports = makePorts();

    await handleProvisioningProcessExit(run, 0, ports);

    expect(ports.updateProgress).toHaveBeenCalledWith(
      run,
      'disconnected',
      'Team process exited normally',
      expect.objectContaining({ disconnect: { kind: 'process_exit', exitCode: 0 } })
    );
    expect(ports.logger.info).toHaveBeenCalledWith('[my-team] Team process exited normally');
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('NM-S03: an exit without a code reports exitCode null', async () => {
    const run = makeRun();
    const ports = makePorts();

    await handleProvisioningProcessExit(run, null, ports);

    expect(ports.updateProgress).toHaveBeenCalledWith(
      run,
      'disconnected',
      'Team process exited unexpectedly (code unknown)',
      expect.objectContaining({ disconnect: { kind: 'process_exit', exitCode: null } })
    );
  });

  it('NM-S01: the progress handed to the renderer carries the same disconnect reason', async () => {
    const run = makeRun();
    const ports = makePorts();

    await handleProvisioningProcessExit(run, 1, ports);

    expect(run.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'disconnected',
        disconnect: { kind: 'process_exit', exitCode: 1 },
      })
    );
  });

  it.each([
    { name: 'cancelRequested', overrides: { cancelRequested: true } },
    { name: 'processKilled', overrides: { processKilled: true } },
    { name: 'authRetryInProgress', overrides: { authRetryInProgress: true } },
  ])('NM-S05: $name exit reports no process_exit', async ({ overrides }) => {
    const run = makeRun(overrides);
    const ports = makePorts();

    await handleProvisioningProcessExit(run, 1, ports);

    expect(ports.updateProgress).not.toHaveBeenCalled();
    expect(run.onProgress).not.toHaveBeenCalled();
  });
});
