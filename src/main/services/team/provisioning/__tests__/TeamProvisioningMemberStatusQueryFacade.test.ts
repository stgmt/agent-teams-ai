import * as agentTeamsControllerModule from 'agent-teams-controller';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningMemberStatusQueryFacade } from '../TeamProvisioningMemberStatusQueryFacade';

import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type {
  InboxMessage,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamProvisioningProgress,
} from '@shared/types';

const { createController } = agentTeamsControllerModule;

// The folder the startup work hand-over reads and writes: a real Claude root in a temp dir.
const claudeRoot = vi.hoisted(() => ({ dir: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getClaudeBasePath: () => claudeRoot.dir,
}));

class TestMemberStatusQueryFacade extends TeamProvisioningMemberStatusQueryFacade<ProvisioningRun> {
  readonly readConfigSnapshotMock = vi.fn(async () => {
    return {
      members: [{ name: 'Worker', providerId: 'opencode' }],
    } as TeamConfig;
  });
  readonly getMembersMock = vi.fn(async () => []);
  readonly getTeamAgentRuntimeSnapshotMock = vi.fn(async () => {
    return { teamName: 'alpha' } as unknown as TeamAgentRuntimeSnapshot;
  });
  readonly getMessagesForMock = vi.fn<
    (teamName: string, memberName: string) => Promise<InboxMessage[]>
  >(async () => []);
  readonly reevaluateMemberLaunchStatusMock = vi.fn(async () => undefined);
  readonly mutationPorts = {
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    updateLaunchDiagnostics: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
  };

  protected readonly compatibilityDelegation = {
    configFacade: {
      readConfigSnapshot: this.readConfigSnapshotMock,
    },
  } as unknown as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {
    isMemberLifecycleOperationActive: vi.fn(() => false),
  } as unknown as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly runTracking = {
    getTrackedRunId: vi.fn((teamName: string) => (teamName === 'alpha' ? 'run-1' : null)),
  };
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly membersMetaStore = {
    getMembers: this.getMembersMock,
  };
  protected readonly inboxReader = {
    getMessagesFor: this.getMessagesForMock,
  };
  protected readonly runtimeToolActivity = {
    startRuntimeToolActivity: vi.fn(),
    finishRuntimeToolActivity: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    resetRuntimeToolActivity: vi.fn(),
    clearMemberSpawnToolTracking: vi.fn(),
    pauseMemberTaskActivityForRuntimeLoss: vi.fn(),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    emitToolActivity: vi.fn(),
  };
  protected readonly memberSpawnStatusMutationPorts = {
    nowIso: () => '2026-07-08T00:00:00.000Z',
    syncMemberTaskActivityForRuntimeTransition:
      this.mutationPorts.syncMemberTaskActivityForRuntimeTransition,
    syncMemberLaunchGraceCheck: this.mutationPorts.syncMemberLaunchGraceCheck,
    updateLaunchDiagnostics: this.mutationPorts.updateLaunchDiagnostics,
    appendMemberBootstrapDiagnostic: this.mutationPorts.appendMemberBootstrapDiagnostic,
    isCurrentTrackedRun: (run: ProvisioningRun) => this.isCurrentTrackedRun(run),
    emitMemberSpawnChange: this.mutationPorts.emitMemberSpawnChange,
    persistLaunchStateSnapshot: this.mutationPorts.persistLaunchStateSnapshot,
    reportBackgroundPersistenceError: vi.fn(),
  };
  protected readonly memberSpawnStatusAuditPorts = {} as never;
  protected readonly runtimeSnapshotFacade = {
    getTeamAgentRuntimeSnapshot: this.getTeamAgentRuntimeSnapshotMock,
    getTeamAgentRuntimeSnapshotReadOnly: this.getTeamAgentRuntimeSnapshotMock,
  };
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    createPorts: vi.fn(),
    reevaluateMemberLaunchStatus: this.reevaluateMemberLaunchStatusMock,
  };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();

  getGraceKey(run: ProvisioningRun, memberName: string): string {
    return this.getMemberLaunchGraceKey(run, memberName);
  }

  syncGrace(run: ProvisioningRun, memberName: string, entry: MemberSpawnStatusEntry): void {
    this.syncMemberLaunchGraceCheck(run, memberName, entry);
  }

  pendingTimeoutCount(): number {
    return this.pendingTimeouts.size;
  }

  transition(
    run: ProvisioningRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry
  ): void {
    this.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      previous,
      next,
      '2026-07-08T00:01:00.000Z'
    );
  }

  setSpawn(run: ProvisioningRun, memberName: string, status: MemberSpawnStatus): void {
    this.setMemberSpawnStatus(run, memberName, status);
  }

  failUnconfirmedBootstrapMembers(run: ProvisioningRun, reason: string): void {
    this.markUnconfirmedBootstrapMembersFailed(run, reason);
  }

  refreshFromLeadInbox(run: ProvisioningRun): Promise<void> {
    return this.refreshMemberSpawnStatusesFromLeadInbox(run);
  }

  resolveExpected(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null {
    return this.resolveExpectedLaunchMemberName(expectedMembers, candidateName);
  }

  protected getRunLeadName(): string {
    return 'Lead';
  }

  protected async findBootstrapTranscriptOutcome() {
    return null;
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized() {
    return {} as never;
  }

  protected emitMemberSpawnChange(run: ProvisioningRun, memberName: string): void {
    this.mutationPorts.emitMemberSpawnChange(run, memberName);
  }

  protected async persistLaunchStateSnapshot(): Promise<unknown> {
    return null;
  }
}

function createRun(): ProvisioningRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    startedAt: '2026-07-08T00:00:00.000Z',
    progress: {
      runId: 'run-1',
      teamName: 'alpha',
      state: 'spawning',
      message: 'running',
      startedAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    } as TeamProvisioningProgress,
    onProgress: vi.fn(),
    expectedMembers: ['Worker'],
    isLaunch: false,
    provisioningComplete: false,
    memberSpawnStatuses: new Map(),
    memberSpawnLeadInboxCursorByMember: new Map(),
    lastMemberSpawnAuditAt: 0,
  } as unknown as ProvisioningRun;
}

describe('TeamProvisioningMemberStatusQueryFacade', () => {
  it('delegates member recipient and runtime snapshot queries through focused ports', async () => {
    const facade = new TestMemberStatusQueryFacade();

    await expect(facade.resolveRuntimeRecipientProviderId('alpha', 'Worker')).resolves.toBe(
      'opencode'
    );
    await expect(facade.isOpenCodeRuntimeRecipient('alpha', 'Worker')).resolves.toBe(true);
    await expect(facade.getTeamAgentRuntimeSnapshot('alpha')).resolves.toEqual({
      teamName: 'alpha',
    });

    expect(facade.readConfigSnapshotMock).toHaveBeenCalledWith('alpha');
    expect(facade.getMembersMock).toHaveBeenCalledWith('alpha');
    expect(facade.getTeamAgentRuntimeSnapshotMock).toHaveBeenCalledWith('alpha');
  });

  it('keeps member launch grace timers scoped to member status handling', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();
    const futureAcceptedAt = new Date(Date.now() + 30_000).toISOString();

    expect(facade.getGraceKey(run, 'Worker')).toBe('member-launch-grace:run-1:Worker');

    facade.syncGrace(run, 'Worker', {
      launchState: 'starting',
      firstSpawnAcceptedAt: futureAcceptedAt,
    } as MemberSpawnStatusEntry);
    expect(facade.pendingTimeoutCount()).toBe(1);

    facade.syncGrace(run, 'Worker', {
      launchState: 'confirmed_alive',
      firstSpawnAcceptedAt: futureAcceptedAt,
    } as MemberSpawnStatusEntry);
    expect(facade.pendingTimeoutCount()).toBe(0);
  });

  it('delegates member spawn status mutations through the status facade ports', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();

    facade.setSpawn(run, 'Worker', 'spawning');

    expect(run.memberSpawnStatuses.get('Worker')?.status).toBe('spawning');
    expect(facade.mutationPorts.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalled();
    expect(facade.mutationPorts.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(
      run,
      'Worker',
      expect.objectContaining({ status: 'spawning' })
    );
    expect(facade.mutationPorts.updateLaunchDiagnostics).toHaveBeenCalledWith(run);
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });

  it('keeps unconfirmed bootstrap failure marking behind the status facade', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();

    facade.failUnconfirmedBootstrapMembers(run, 'bootstrap timed out');

    expect(run.memberSpawnStatuses.get('Worker')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'bootstrap timed out',
    });
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });

  it('keeps lead-inbox spawn refresh and expected-name resolution behind the status facade', async () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();
    facade.getMessagesForMock.mockResolvedValue([
      {
        messageId: 'msg-1',
        from: 'Worker',
        to: 'Lead',
        timestamp: '2026-07-08T00:00:05.000Z',
        text: 'heartbeat 2026-07-08T00:00:04.000Z',
        read: false,
      },
    ]);

    expect(facade.resolveExpected(['Worker'], 'Worker-2')).toBe('Worker');

    await facade.refreshFromLeadInbox(run);

    expect(facade.getMessagesForMock).toHaveBeenCalledWith('alpha', 'Lead');
    expect(run.memberSpawnStatuses.get('Worker')).toMatchObject({
      status: 'online',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      lastHeartbeatAt: '2026-07-08T00:00:05.000Z',
    });
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });

  describe('startup work hand-over on the first confirmation of a launch attempt', () => {
    // Every change of a member launch status passes through
    // syncMemberTaskActivityForRuntimeTransition, so the hand-over lives there and is checked
    // there against a real controller, board and inbox files. Which paths lead into it
    // (events, transcript proof, the overlay of the bootstrap state read by every status
    // poll) is checked in the live runs, S1.1 and S1.4.
    const attempt = '2026-07-08T00:00:03.000Z';
    const waiting = {
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      firstSpawnAcceptedAt: attempt,
      updatedAt: '2026-07-08T00:00:04.000Z',
    } as MemberSpawnStatusEntry;
    const confirmed = {
      ...waiting,
      status: 'online',
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    } as MemberSpawnStatusEntry;

    const teamDir = () => join(claudeRoot.dir, 'teams', 'alpha');
    const inboxFile = () => join(teamDir(), 'inboxes', 'Worker.json');
    const startupRows = (): { messageId: string; read: boolean }[] =>
      existsSync(inboxFile())
        ? (
            JSON.parse(readFileSync(inboxFile(), 'utf8')) as { messageId: string; read: boolean }[]
          ).filter((row) => String(row.messageId).startsWith('startup-work:'))
        : [];
    const markInboxRead = () =>
      writeFileSync(
        inboxFile(),
        JSON.stringify(
          (JSON.parse(readFileSync(inboxFile(), 'utf8')) as object[]).map((row) => ({
            ...row,
            read: true,
          }))
        )
      );
    const runWithMember = (): ProvisioningRun =>
      ({
        ...createRun(),
        allEffectiveMembers: [{ name: 'Worker', role: 'developer' }],
      }) as unknown as ProvisioningRun;

    beforeEach(() => {
      claudeRoot.dir = mkdtempSync(join(tmpdir(), 'status-facade-funnel-'));
      mkdirSync(teamDir(), { recursive: true });
      writeFileSync(
        join(teamDir(), 'config.json'),
        JSON.stringify({
          name: 'alpha',
          leadSessionId: 'lead-session-1',
          members: [
            { name: 'Lead', role: 'team-lead' },
            { name: 'Worker', role: 'developer' },
          ],
        })
      );
      createController({ teamName: 'alpha', claudeDir: claudeRoot.dir }).taskBoard.createTask({
        subject: 'Job for the worker',
        owner: 'Worker',
      });
      // Creating the task already told the member; the hand-over skips a task whose notice is
      // still unread, so the notice is read, as it is for a member that has since been started.
      markInboxRead();
    });

    afterEach(() => rmSync(claudeRoot.dir, { recursive: true, force: true }));

    it('S1.3: the first confirmation puts the work in the inbox, keyed by the launch attempt', () => {
      const facade = new TestMemberStatusQueryFacade();

      facade.transition(runWithMember(), 'Worker', waiting, confirmed);

      expect(startupRows()).toHaveLength(1);
      expect(startupRows()[0]?.messageId).toMatch(
        new RegExp(`^startup-work:run-1@${attempt}:worker:`)
      );
    });

    it('S1.12: a status that stays confirmed hands nothing over again', () => {
      const facade = new TestMemberStatusQueryFacade();
      const run = runWithMember();

      facade.transition(run, 'Worker', waiting, confirmed);
      markInboxRead();
      facade.transition(run, 'Worker', confirmed, {
        ...confirmed,
        updatedAt: '2026-07-08T00:02:00.000Z',
      });

      expect(startupRows()).toHaveLength(1);
    });

    it('S1.13: a live process alone is not a confirmation, so no work is handed over', () => {
      const facade = new TestMemberStatusQueryFacade();

      facade.transition(runWithMember(), 'Worker', waiting, {
        ...waiting,
        status: 'online',
        livenessSource: 'process',
      } as MemberSpawnStatusEntry);

      expect(startupRows()).toEqual([]);
    });

    it('S1.18: a restart inside the run is a new launch attempt and hands the work over again', () => {
      const facade = new TestMemberStatusQueryFacade();
      const run = runWithMember();

      facade.transition(run, 'Worker', waiting, confirmed);
      markInboxRead();
      const restartedAt = '2026-07-08T00:20:00.000Z';
      facade.transition(
        run,
        'Worker',
        { ...waiting, firstSpawnAcceptedAt: restartedAt },
        { ...confirmed, firstSpawnAcceptedAt: restartedAt }
      );

      expect(startupRows().map((row) => row.messageId.split(':worker:')[0])).toEqual([
        `startup-work:run-1@${attempt}`,
        `startup-work:run-1@${restartedAt}`,
      ]);
    });

    it('a run that is no longer the tracked one hands nothing over', () => {
      const facade = new TestMemberStatusQueryFacade();

      facade.transition(
        { ...runWithMember(), runId: 'run-0' } as ProvisioningRun,
        'Worker',
        waiting,
        confirmed
      );

      expect(startupRows()).toEqual([]);
    });
  });
});
