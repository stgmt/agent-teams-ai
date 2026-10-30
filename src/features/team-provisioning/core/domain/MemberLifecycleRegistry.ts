import { LifecycleSnapshotFeed } from './LifecycleSnapshotFeed';
import { MemberRestartConflictError } from './MemberRestartConflictError';
import { MemberSkipConflictError } from './MemberSkipConflictError';
import { teamLifecycleState } from './teamLifecycleState';

import type {
  ConfiguredMemberIdentity,
  MemberGenerationTarget,
  MemberLifecycleSnapshot,
  MemberProcessToken,
  MemberStartAdmission,
  OwnedProcessIdentity,
  TeamLifecycleFeed,
  TeamLifecycleSnapshot,
  TeamRunIdentity,
  TeamRunResourceState,
} from '../../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

interface MemberState extends MemberLifecycleSnapshot {
  connectedGeneration: number | null;
}
interface TeamState {
  identity: TeamRunIdentity;
  desired: 'running' | 'stopped';
  resources: TeamRunResourceState;
  error: string | null;
  version: number;
  members: Map<string, MemberState>;
}

function sameOwner(a: AppConnectionContext, b: AppConnectionContext): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration
  );
}

function sameProcess(a: Readonly<OwnedProcessIdentity> | null, b: OwnedProcessIdentity): boolean {
  return a !== null && a.pid === b.pid && a.birthId === b.birthId;
}

function tokenFor(team: TeamState, member: MemberState): Readonly<MemberProcessToken> {
  if (!member.operationId) throw new Error('Member has no start operation');
  return Object.freeze({
    ...team.identity,
    memberName: member.memberName,
    generation: member.generation,
    operationId: member.operationId,
  });
}

export class MemberLifecycleRegistry {
  private readonly teams = new Map<string, TeamState>();
  private readonly owner: Readonly<AppConnectionContext>;
  private readonly feeds = new Map<string, Set<LifecycleSnapshotFeed>>();
  private readonly pendingPublications = new Set<string>();
  private startsClosed = false;

  constructor(owner: AppConnectionContext) {
    this.owner = Object.freeze({ ...owner });
  }

  assertOwner(identity: TeamRunIdentity): void {
    if (!sameOwner(this.owner, identity)) throw new Error('Foreign application owner');
    if (!identity.teamName.trim() || !identity.runId.trim())
      throw new Error('Invalid team run identity');
  }

  assertStartsOpen(): void {
    if (this.startsClosed) throw new Error('Application lifecycle admission is closed');
  }

  closeStarts(): readonly Readonly<TeamRunIdentity>[] {
    this.startsClosed = true;
    const runs = [...this.teams.values()].map((team) => Object.freeze({ ...team.identity }));
    for (const run of runs) this.requestTeamStop(run);
    return Object.freeze(runs);
  }

  assertCanConfigure(identity: TeamRunIdentity): void {
    this.assertStartsOpen();
    this.assertOwner(identity);
    const previous = this.teams.get(identity.teamName);
    if (
      previous &&
      (previous.resources !== 'released' ||
        [...previous.members.values()].some(
          (member) =>
            member.desired === 'running' ||
            member.resources !== 'released' ||
            member.process !== null ||
            member.phase === 'stopping'
        ))
    )
      throw new Error('Cannot replace an active team run');
    if (previous?.identity.runId === identity.runId)
      throw new Error('Team run is already configured');
  }

  beginPreparation(identity: TeamRunIdentity): void {
    this.assertCanConfigure(identity);
    const previous = this.teams.get(identity.teamName);
    this.teams.set(identity.teamName, {
      identity: { ...identity },
      desired: 'running',
      resources: 'preparing',
      error: null,
      version: (previous?.version ?? 0) + 1,
      members: new Map(),
    });
    this.publishChanged(identity.teamName);
  }

  observePreparationFailed(identity: TeamRunIdentity, error: string): void {
    const team = this.requireRun(identity);
    if (team.resources !== 'preparing' && team.resources !== 'releasing') return;
    team.resources = 'released';
    team.error = team.desired === 'stopped' ? null : error;
    this.changed(team);
  }

  beginRelease(identity: TeamRunIdentity): void {
    const team = this.requireRun(identity);
    if (team.resources === 'releasing') return;
    team.resources = 'releasing';
    this.changed(team);
  }

  observeReleased(identity: TeamRunIdentity): void {
    const team = this.requireRun(identity);
    if (
      [...team.members.values()].some(
        (member) => member.resources !== 'released' || member.process !== null
      )
    )
      throw new Error('Member resources are not released');
    if (team.resources === 'released' && team.error === null) return;
    team.resources = 'released';
    team.error = null;
    this.changed(team);
  }

  observeReleaseFailed(identity: TeamRunIdentity, error: string): void {
    const team = this.requireRun(identity);
    team.resources = 'release-failed';
    team.error = error;
    this.changed(team);
  }

  configureTeam(identity: TeamRunIdentity, members: readonly ConfiguredMemberIdentity[]): void {
    this.assertStartsOpen();
    const previous = this.teams.get(identity.teamName);
    if (previous?.identity.runId === identity.runId) {
      this.requireRun(identity);
      if (previous.resources !== 'preparing' || previous.desired !== 'running')
        throw new Error('Team run is already configured');
    } else this.assertCanConfigure(identity);
    const configured = new Map<string, MemberState>();
    for (const member of members) {
      if (!member.memberName.trim() || configured.has(member.memberName)) {
        throw new Error('Invalid or duplicate configured member');
      }
      configured.set(member.memberName, {
        ...member,
        membership: 'configured',
        desired: 'stopped',
        phase: 'stopped',
        resources: 'released',
        generation: 0,
        operationId: null,
        process: null,
        everConnected: false,
        connectedGeneration: null,
        skippedForLaunch: false,
        error: null,
        exit: null,
      });
    }
    this.teams.set(identity.teamName, {
      identity: { ...identity },
      desired: 'running',
      resources: 'held',
      error: null,
      version: (previous?.version ?? 0) + 1,
      members: configured,
    });
    this.publishChanged(identity.teamName);
  }

  beginStart(
    identity: TeamRunIdentity,
    memberName: string,
    operationId: string
  ): MemberStartAdmission {
    this.assertStartsOpen();
    const team = this.requireRun(identity);
    const member = this.requireMember(team, memberName);
    if (member.membership === 'removed') throw new Error('Member was removed');
    if (member.role === 'lead') throw new Error('Member start cannot target the lead');
    return this.admitStart(team, member, operationId);
  }

  assertRestartTarget(target: MemberGenerationTarget): void {
    this.assertStartsOpen();
    const team = this.teams.get(target.teamName);
    if (!team || !sameOwner(this.owner, target) || team.identity.runId !== target.runId)
      throw new MemberRestartConflictError('The application or team run identity is stale');
    const member = team.members.get(target.memberName);
    if (!member) throw new MemberRestartConflictError('Member is not configured');
    if (team.desired !== 'running')
      throw new MemberRestartConflictError('Team run is intentionally stopped');
    if (member.membership !== 'configured')
      throw new MemberRestartConflictError('Member was removed');
    if (member.role === 'lead') throw new TypeError('Member restart cannot target the lead');
    if (
      !Number.isSafeInteger(target.generation) ||
      target.generation < 0 ||
      target.generation !== member.generation
    )
      throw new MemberRestartConflictError('Observed member generation is stale');
  }

  skipMemberForLaunch(target: MemberGenerationTarget): void {
    const team = this.teams.get(target.teamName);
    if (!team || !sameOwner(this.owner, target) || team.identity.runId !== target.runId)
      throw new MemberSkipConflictError('The application or team run identity is stale');
    const member = team.members.get(target.memberName);
    if (member?.membership !== 'configured')
      throw new MemberSkipConflictError('Member is not configured');
    if (member.role === 'lead') throw new TypeError('The lead cannot be skipped for a launch');
    if (team.desired !== 'running')
      throw new MemberSkipConflictError('Team run is intentionally stopped');
    if (!Number.isSafeInteger(target.generation) || target.generation !== member.generation)
      throw new MemberSkipConflictError('Observed member generation is stale');
    if (member.skippedForLaunch) return;
    if (
      member.generation < 1 ||
      member.connectedGeneration === member.generation ||
      member.desired !== 'running' ||
      !['failed', 'exited'].includes(member.phase)
    )
      throw new MemberSkipConflictError('Member has no failed startup in the observed generation');
    if (member.process !== null || member.resources !== 'released')
      throw new MemberSkipConflictError('Member startup resources are not released');
    member.desired = 'stopped';
    member.phase = 'stopped';
    member.skippedForLaunch = true;
    this.changed(team);
  }

  beginTeamStart(
    identity: TeamRunIdentity,
    nextOperationId: () => string
  ): readonly Readonly<MemberProcessToken>[] {
    this.assertStartsOpen();
    const team = this.requireRun(identity);
    if (team.desired !== 'running') throw new Error('Team run is intentionally stopped');
    return [...team.members.values()]
      .filter((member) => member.membership === 'configured')
      .flatMap((member) => {
        const admission = this.admitStart(team, member, nextOperationId());
        return admission.kind === 'launch' ? [admission.token] : [];
      });
  }

  private admitStart(
    team: TeamState,
    member: MemberState,
    operationId: string
  ): MemberStartAdmission {
    if (team.desired !== 'running') throw new Error('Team run is intentionally stopped');
    if (member.phase === 'stopping') return { kind: 'stopping' };
    if (member.phase === 'starting' || member.phase === 'connecting') {
      return { kind: 'pending', token: tokenFor(team, member) };
    }
    if (member.process !== null) return { kind: 'already-running' };
    if (member.resources !== 'released') return { kind: 'stopping' };
    if (!operationId.trim()) throw new Error('Start operation ID is required');
    member.desired = 'running';
    member.phase = 'starting';
    member.resources = 'preparing';
    member.generation++;
    member.operationId = operationId;
    member.skippedForLaunch = false;
    member.error = null;
    member.exit = null;
    this.changed(team);
    return { kind: 'launch', token: tokenFor(team, member) };
  }

  observeSpawn(token: MemberProcessToken, process: OwnedProcessIdentity): boolean {
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || !process.birthId.trim()) {
      throw new Error('Process birth identity is required');
    }
    const current = this.current(token);
    if (!current) return false;
    const { team, member } = current;
    if (member.process !== null || (member.phase !== 'starting' && member.phase !== 'stopping'))
      return false;
    member.process = Object.freeze({ ...process });
    member.resources = 'held';
    member.phase = member.desired === 'running' ? 'connecting' : 'stopping';
    this.changed(team);
    return true;
  }

  observeConnected(token: MemberProcessToken): boolean {
    const current = this.current(token);
    if (!current) return false;
    const { team, member } = current;
    if (
      member.desired !== 'running' ||
      member.process === null ||
      member.membership !== 'configured'
    )
      return false;
    if (member.phase === 'ready') return true;
    if (member.phase !== 'connecting' && member.phase !== 'unresponsive') return false;
    member.phase = 'ready';
    member.everConnected = true;
    member.connectedGeneration = member.generation;
    this.changed(team);
    return true;
  }

  observeConnectionLost(token: MemberProcessToken): boolean {
    const current = this.current(token);
    if (current?.member.phase !== 'ready') return false;
    current.member.phase = 'unresponsive';
    this.changed(current.team);
    return true;
  }

  observeExit(
    token: MemberProcessToken,
    process: OwnedProcessIdentity,
    exit: { code: number | null; signal: string | null }
  ): boolean {
    const current = this.current(token);
    if (!current || !sameProcess(current.member.process, process)) return false;
    current.member.process = null;
    current.member.resources = 'releasing';
    current.member.phase =
      current.member.desired === 'stopped' ? 'stopped' : current.member.error ? 'failed' : 'exited';
    current.member.exit = Object.freeze({ ...exit });
    this.changed(current.team);
    return true;
  }

  observeStartFailed(token: MemberProcessToken, error: string): boolean {
    const current = this.current(token);
    if (
      current?.member.process !== null ||
      (current.member.phase !== 'starting' && current.member.phase !== 'stopping')
    )
      return false;
    current.member.phase = current.member.desired === 'stopped' ? 'stopped' : 'failed';
    current.member.error = error;
    this.changed(current.team);
    return true;
  }

  observeRuntimeFailed(token: MemberProcessToken, error: string): boolean {
    const current = this.current(token);
    if (!current || !error.trim()) return false;
    current.member.error = error;
    current.member.phase =
      current.member.desired === 'stopped'
        ? current.member.process
          ? 'stopping'
          : 'stopped'
        : 'failed';
    this.changed(current.team);
    return true;
  }

  observeMemberReleased(token: MemberProcessToken): boolean {
    const current = this.current(token);
    if (current?.member.process !== null) return false;
    if (current.member.resources === 'released') return true;
    current.member.resources = 'released';
    this.changed(current.team);
    return true;
  }

  observeMemberReleaseFailed(token: MemberProcessToken): boolean {
    const current = this.current(token);
    if (!current || current.member.resources === 'released') return false;
    if (current.member.resources === 'release-failed') return true;
    current.member.resources = 'release-failed';
    this.changed(current.team);
    return true;
  }

  requestStop(identity: TeamRunIdentity, memberName: string): Readonly<MemberProcessToken> | null {
    const team = this.requireRun(identity);
    const member = this.requireMember(team, memberName);
    if (
      member.desired === 'stopped' &&
      (member.phase === 'stopping' || member.phase === 'stopped')
    ) {
      return member.operationId ? tokenFor(team, member) : null;
    }
    const pending = member.phase === 'starting' || member.phase === 'connecting';
    member.desired = 'stopped';
    member.phase = member.process !== null || pending ? 'stopping' : 'stopped';
    this.changed(team);
    return member.operationId ? tokenFor(team, member) : null;
  }

  requestTeamStop(identity: TeamRunIdentity): void {
    const team = this.requireRun(identity);
    if (team.desired !== 'stopped') {
      team.desired = 'stopped';
      this.changed(team);
    }
    for (const name of team.members.keys()) this.requestStop(identity, name);
  }

  removeMember(identity: TeamRunIdentity, memberName: string): void {
    const team = this.requireRun(identity);
    const member = this.requireMember(team, memberName);
    if (member.role === 'lead') throw new Error('Cannot remove the lead through member lifecycle');
    if (member.membership === 'removed') return;
    this.requestStop(identity, memberName);
    member.membership = 'removed';
    this.changed(team);
  }

  recoveryCandidates(teamName: string): readonly string[] {
    const team = this.requireTeam(teamName);
    return Object.freeze(
      [...team.members.values()]
        .filter(
          (member) =>
            member.membership === 'configured' &&
            member.desired === 'running' &&
            member.resources === 'released' &&
            member.process === null &&
            (member.phase === 'exited' || member.phase === 'failed')
        )
        .map((member) => member.memberName)
    );
  }

  watch(teamName: string): TeamLifecycleFeed {
    if (!teamName.trim()) throw new Error('Team name is required');
    const feeds = this.feeds.get(teamName) ?? new Set<LifecycleSnapshotFeed>();
    const feed = new LifecycleSnapshotFeed(() => {
      feeds.delete(feed);
      if (!feeds.size && this.feeds.get(teamName) === feeds) this.feeds.delete(teamName);
    });
    feeds.add(feed);
    this.feeds.set(teamName, feeds);
    const snapshot = this.findSnapshot(teamName);
    if (snapshot) feed.publish(snapshot);
    return feed;
  }

  private changed(team: TeamState): void {
    team.version++;
    this.publishChanged(team.identity.teamName);
  }

  private publishChanged(teamName: string): void {
    if (!this.feeds.has(teamName) || this.pendingPublications.has(teamName)) return;
    this.pendingPublications.add(teamName);
    // Publish the complete synchronous transition; observers cannot re-enter a domain mutation.
    queueMicrotask(() => {
      this.pendingPublications.delete(teamName);
      const feeds = this.feeds.get(teamName);
      if (!feeds?.size) return;
      const snapshot = this.snapshot(teamName);
      for (const feed of feeds) feed.publish(snapshot);
    });
  }

  findSnapshot(teamName: string): Readonly<TeamLifecycleSnapshot> | null {
    return this.teams.has(teamName) ? this.snapshot(teamName) : null;
  }

  /** Teams with at least one owned process; historical connections do not count. */
  aliveTeamNames(): readonly string[] {
    return [...this.teams]
      .filter(([, team]) =>
        [...team.members.values()].some(
          (entry) => entry.membership === 'configured' && entry.process !== null
        )
      )
      .map(([teamName]) => teamName)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Current run identity only while the team still owns a process. */
  aliveRunId(teamName: string): string | null {
    const team = this.teams.get(teamName);
    if (!team) return null;
    return [...team.members.values()].some(
      (entry) => entry.membership === 'configured' && entry.process !== null
    )
      ? team.identity.runId
      : null;
  }

  snapshot(teamName: string): Readonly<TeamLifecycleSnapshot> {
    const team = this.requireTeam(teamName);
    const entries = [...team.members].map(
      ([name, { connectedGeneration: _connectedGeneration, ...member }]) =>
        [name, Object.freeze(member)] as const
    );
    return Object.freeze({
      identity: Object.freeze({ ...team.identity }),
      desired: team.desired,
      resources: team.resources,
      state: teamLifecycleState({ ...team, members: team.members.values() }),
      error: team.error,
      version: team.version,
      members: Object.freeze(Object.fromEntries(entries)),
    });
  }

  assertRun(identity: TeamRunIdentity): void {
    this.requireRun(identity);
  }

  private requireTeam(teamName: string): TeamState {
    const team = this.teams.get(teamName);
    if (!team) throw new Error(`Unknown team: ${teamName}`);
    return team;
  }

  private requireRun(identity: TeamRunIdentity): TeamState {
    const team = this.requireTeam(identity.teamName);
    if (!sameOwner(this.owner, identity) || team.identity.runId !== identity.runId) {
      throw new Error('The application or team run identity is stale');
    }
    return team;
  }

  private requireMember(team: TeamState, name: string): MemberState {
    const member = team.members.get(name);
    if (!member) throw new Error(`Member is not configured: ${name}`);
    return member;
  }

  private current(token: MemberProcessToken): { team: TeamState; member: MemberState } | null {
    const team = this.teams.get(token.teamName);
    if (!team || !sameOwner(this.owner, token) || team.identity.runId !== token.runId) return null;
    const member = team.members.get(token.memberName);
    if (
      member?.generation !== token.generation ||
      member.operationId !== token.operationId ||
      member.skippedForLaunch
    )
      return null;
    return { team, member };
  }
}
