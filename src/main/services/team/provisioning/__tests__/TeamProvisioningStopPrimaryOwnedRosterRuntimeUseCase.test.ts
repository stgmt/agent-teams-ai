import { describe, expect, it } from 'vitest';

import { createStopPrimaryOwnedRosterRuntimeUseCase } from '../TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';

import type { ProcessInspection } from '../TeamProvisioningMemberProcessControl';

function createPorts(
  overrides: {
    alivePids?: readonly number[];
    lingeringPids?: number[];
    lingeringPaneIds?: string[];
    inspection?: (pid: number) => ProcessInspection;
    paneInfo?: ReadonlyMap<string, { panePid: number }>;
    processCommandByPid?: (pid: number) => string | null;
    processRows?: readonly { pid: number; ppid: number; command: string }[] | null;
    throwOnPane?: string;
    throwOnPid?: number;
  } = {}
) {
  const calls = {
    killedPanes: [] as string[],
    killedPids: [] as number[],
    waitPaneCalls: [] as Array<{ paneIds: readonly string[]; timeoutMs: number; pollMs: number }>,
    debug: [] as string[],
    diagnostics: [] as string[],
    warnings: [] as string[],
    paneInfoReads: [] as string[][],
    processTableReads: [] as { bypassCache: boolean }[],
  };

  const alivePids = new Set(overrides.alivePids ?? []);

  return {
    calls,
    ports: {
      isProcessAlive(pid: number) {
        return alivePids.has(pid);
      },
      async inspectProcess(pid: number): Promise<ProcessInspection> {
        if (overrides.inspection) {
          return overrides.inspection(pid);
        }
        const command =
          overrides.processCommandByPid?.(pid) ??
          'bun cli.js --team-name team-a --agent-name Worker --agent-id Worker@team-a';
        return command === null ? { status: 'not_found' } : { status: 'found', command };
      },
      async listTmuxPaneRuntimeInfo(paneIds: readonly string[]) {
        calls.paneInfoReads.push([...paneIds]);
        return (
          overrides.paneInfo ??
          new Map(paneIds.map((paneId, index) => [paneId, { panePid: 900 + index }]))
        );
      },
      async listRuntimeProcesses(options: { bypassCache: boolean }) {
        calls.processTableReads.push(options);
        return overrides.processRows ?? [];
      },
      killTmuxPane(paneId: string) {
        calls.killedPanes.push(paneId);
        if (paneId === overrides.throwOnPane) {
          throw new Error(`pane failed ${paneId}`);
        }
      },
      async terminateProcess(pid: number) {
        calls.killedPids.push(pid);
        if (pid === overrides.throwOnPid) {
          throw new Error(`pid failed ${pid}`);
        }
        if (overrides.lingeringPids?.includes(pid)) {
          throw new Error(`Process ${pid} remained alive after cleanup`);
        }
      },
      async waitForTmuxPanesToExit(
        paneIds: readonly string[],
        options: { timeoutMs: number; pollMs: number }
      ) {
        calls.waitPaneCalls.push({ paneIds, ...options });
        return overrides.lingeringPaneIds ?? [];
      },
      logDebug(message: string) {
        calls.debug.push(message);
      },
      logDiagnostic(message: string) {
        calls.diagnostics.push(message);
      },
      logWarning(message: string) {
        calls.warnings.push(message);
      },
    },
  };
}

describe('TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase', () => {
  it('stops persisted and live primary-owned runtime handles through narrow ports', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Detach for teammate "Worker"',
      persistedRuntimeMembers: [
        { backendType: 'process', runtimePid: 111 },
        { backendType: 'tmux', tmuxPaneId: ' pane-a ' },
      ],
      liveRuntimeByMember: new Map([
        [
          'Worker',
          {
            alive: true,
            backendType: 'tmux',
            tmuxPaneId: 'pane-b',
            pid: 222,
            metricsPid: 333,
          },
        ],
        ['Other', { alive: true, backendType: 'process', pid: 444 }],
      ]),
    });

    expect(calls.killedPanes).toEqual(['pane-a', 'pane-b']);
    expect(calls.killedPids).toEqual([111, 222, 333]);
    expect(calls.waitPaneCalls).toEqual([
      { paneIds: ['pane-a', 'pane-b'], timeoutMs: 1_500, pollMs: 100 },
    ]);
  });

  it('ignores stale live runtime pids when metadata reports the runtime is not alive', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: false, backendType: 'process', pid: 222, metricsPid: 333 }],
        ]),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPids).toEqual([]);
  });

  it('logs a pane kill failure and still waits for the pane', async () => {
    const { calls, ports } = createPorts({ throwOnPane: 'pane-a' });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Update for teammate "Worker"',
      persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a' }],
      liveRuntimeByMember: new Map(),
    });

    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.debug).toEqual([
      expect.stringContaining('Failed to stop teammate pane Worker pane-a'),
    ]);
  });

  it('reports the real cause when a process cannot be stopped, never swallows it', async () => {
    const { ports } = createPorts({ throwOnPid: 111 });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Update for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow(
      'Update for teammate "Worker" could not stop the previous process: pid 111: pid failed 111'
    );
  });

  it('stops every collected process and reports each failure', async () => {
    const { calls, ports } = createPorts({ throwOnPid: 222 });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Update for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'process', pid: 222, metricsPid: 333 }],
        ]),
      })
    ).rejects.toThrow('pid 222: pid failed 222');

    expect(calls.killedPids).toEqual([111, 222, 333]);
  });

  it('treats a persisted pid that no longer exists as already stopped', async () => {
    const { calls, ports } = createPorts({ inspection: () => ({ status: 'not_found' }) });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Update for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPids).toEqual([]);
    expect(calls.warnings).toEqual([]);
  });

  it('does not call an unreadable process list a foreign process', async () => {
    const { calls, ports } = createPorts({
      alivePids: [111],
      inspection: () => ({
        status: 'unreadable',
        cause: 'windows_process_inspection: timedOut=true',
      }),
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Update for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow(
      'Update for teammate "Worker" cannot verify the persisted runtime identity of pid 111 (the process list could not be read): windows_process_inspection: timedOut=true'
    );

    expect(calls.killedPids).toEqual([]);
    expect(calls.warnings).toEqual([]);
  });

  it('records the identity result and the stop duration in the durable log', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await stopPrimaryOwnedRosterRuntime({
      teamName: 'team-a',
      memberName: 'Worker',
      actionLabel: 'Update for teammate "Worker"',
      persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
      liveRuntimeByMember: new Map(),
    });

    expect(calls.diagnostics).toEqual([
      '[team-a] Update for teammate "Worker": identity of pid=111 is found',
      expect.stringMatching(/^\[team-a\] Update for teammate "Worker": stopped pid=111 in \d+ ms$/),
    ]);
  });

  it('rejects alive runtime metadata without a pid or tmux pane', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [],
        liveRuntimeByMember: new Map([['Worker', { alive: true, backendType: 'process' }]]),
      })
    ).rejects.toThrow(
      'Detach for teammate "Worker" cannot stop the existing runtime because it does not expose a pid or tmux pane.'
    );
    expect(calls.killedPanes).toEqual([]);
    expect(calls.killedPids).toEqual([]);
  });

  it('refuses a recycled persisted pid whose command belongs to another runtime', async () => {
    const { calls, ports } = createPorts({
      alivePids: [111],
      processCommandByPid: () => 'node unrelated.js --team-name another-team --agent-name Worker',
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow(
      'Detach for teammate "Worker" refuses to stop pid 111: the process is not the runtime of this teammate'
    );

    expect(calls.killedPids).toEqual([]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('process identity does not match the exact team and member'),
    ]);
  });

  it('refuses a persisted tmux pane whose descendant belongs to another member', async () => {
    const { calls, ports } = createPorts({
      paneInfo: new Map([['pane-a', { panePid: 420 }]]),
      processCommandByPid: () => '/bin/zsh',
      processRows: [
        { pid: 421, ppid: 420, command: '/bin/zsh -l' },
        {
          pid: 422,
          ppid: 421,
          command: 'bun cli.js --team-name team-a --agent-name Other --agent-id Other@team-a',
        },
      ],
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        ]),
      })
    ).rejects.toThrow('does not expose a pid or tmux pane');

    expect(calls.killedPanes).toEqual([]);
    expect(calls.processTableReads).toEqual([{ bypassCache: true }]);
    expect(calls.warnings).toEqual([
      expect.stringContaining('pane runtime identity does not match the exact team and member'),
    ]);
  });

  it('stops a persisted tmux pane with an exact teammate descendant', async () => {
    const { calls, ports } = createPorts({
      paneInfo: new Map([['pane-a', { panePid: 430 }]]),
      processCommandByPid: () => '/bin/zsh',
      processRows: [
        { pid: 431, ppid: 430, command: '/bin/zsh -l' },
        {
          pid: 432,
          ppid: 431,
          command: 'bun cli.js --team-name team-a --agent-id Worker@team-a',
        },
      ],
    });
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a', runtimePid: 432 }],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        ]),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPanes).toEqual(['pane-a']);
    expect(calls.waitPaneCalls).toEqual([{ paneIds: ['pane-a'], timeoutMs: 1_500, pollMs: 100 }]);
    expect(calls.processTableReads).toEqual([{ bypassCache: true }]);
  });

  it('stops killable handles when another matching live runtime is handle-less', async () => {
    const { calls, ports } = createPorts();
    const stopPrimaryOwnedRosterRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(ports);

    await expect(
      stopPrimaryOwnedRosterRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [],
        liveRuntimeByMember: new Map([
          ['Worker', { alive: true, backendType: 'process' }],
          ['Worker-2', { alive: true, backendType: 'process', pid: 222 }],
        ]),
      })
    ).resolves.toBeUndefined();

    expect(calls.killedPids).toEqual([222]);
  });

  it('surfaces lingering process and pane evidence after stop attempts', async () => {
    const processPorts = createPorts({ lingeringPids: [111] });
    const stopProcessRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(processPorts.ports);

    await expect(
      stopProcessRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'process', runtimePid: 111 }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow(
      'Detach for teammate "Worker" could not stop the previous process: pid 111: Process 111 remained alive after cleanup'
    );

    const panePorts = createPorts({ lingeringPaneIds: ['pane-a'] });
    const stopPaneRuntime = createStopPrimaryOwnedRosterRuntimeUseCase(panePorts.ports);

    await expect(
      stopPaneRuntime({
        teamName: 'team-a',
        memberName: 'Worker',
        actionLabel: 'Detach for teammate "Worker"',
        persistedRuntimeMembers: [{ backendType: 'tmux', tmuxPaneId: 'pane-a' }],
        liveRuntimeByMember: new Map(),
      })
    ).rejects.toThrow('Detach for teammate "Worker" is still waiting for tmux pane exit (pane-a).');
  });
});
