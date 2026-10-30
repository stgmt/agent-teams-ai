import { describe, expect, it } from 'vitest';

import { MemberLifecycleRegistry } from '../../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

const owner = { appInstanceId: 'app-1', dataRootFingerprint: 'root-1', connectionGeneration: 1 };
const run = { ...owner, teamName: 'TEST-team', runId: 'run-1' };
const member = { memberName: 'builder', role: 'member' as const };

function setup() {
  const registry = new MemberLifecycleRegistry(owner);
  registry.configureTeam(run, [{ memberName: 'team-lead', role: 'lead' }, member]);
  return registry;
}

function start(registry: MemberLifecycleRegistry, operationId = 'start-1') {
  const admission = registry.beginStart(run, member.memberName, operationId);
  if (admission.kind !== 'launch') throw new Error('Expected launch admission');
  return admission.token;
}

function ready(registry: MemberLifecycleRegistry) {
  const token = start(registry);
  const process = { pid: 123, birthId: 'birth-1' };
  registry.observeSpawn(token, process);
  registry.observeConnected(token);
  return { token, process };
}

describe('authoritative member lifecycle', () => {
  it('reports alive teams and runs only from owned processes', () => {
    const registry = setup();
    expect(registry.aliveTeamNames()).toEqual([]);
    expect(registry.aliveRunId(run.teamName)).toBeNull();
    expect(registry.hasRun(run)).toBe(true);
    expect(registry.isLive(run)).toBe(true);
    expect(registry.hasRun({ ...run, runId: 'other-run' })).toBe(false);
    expect(registry.isLive({ ...run, runId: 'other-run' })).toBe(false);
    expect(registry.find(run.teamName)?.identity).toEqual(run);
    const { token, process } = ready(registry);
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);
    expect(registry.aliveRunId(run.teamName)).toBe(run.runId);
    registry.observeExit(token, process, { code: 1, signal: null });
    expect(registry.aliveTeamNames()).toEqual([]);
    expect(registry.aliveRunId(run.teamName)).toBeNull();
    // A crashed run still owns its resources until it is stopped.
    expect(registry.hasRun(run)).toBe(true);
    expect(registry.isLive(run)).toBe(true);
    registry.requestTeamStop(run);
    registry.beginRelease(run);
    registry.observeMemberReleased(token);
    registry.observeReleased(run);
    expect(registry.hasRun(run)).toBe(true);
    expect(registry.isLive(run)).toBe(false);
  });

  it('compares the full run identity, not only the team or run id', () => {
    const registry = setup();
    expect(registry.hasRun({ ...run, appInstanceId: 'foreign-app' })).toBe(false);
    expect(registry.hasRun({ ...run, dataRootFingerprint: 'foreign-root' })).toBe(false);
    expect(registry.hasRun({ ...run, connectionGeneration: 2 })).toBe(false);
    expect(registry.hasRun({ ...run, teamName: 'other-team' })).toBe(false);
    expect(registry.hasRun({ ...run, runId: '' })).toBe(false);
    expect(registry.find('other-team')).toBeNull();
    expect(registry.find('')).toBeNull();
    expect(registry.findByRunId(run.runId)?.identity).toEqual(run);
    expect(registry.findByRunId('other-run')).toBeNull();
    expect(registry.findByRunId('')).toBeNull();
  });

  it('excludes a removed member from liveness even while its process is still owned', () => {
    const registry = setup();
    const { token, process } = ready(registry);
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);
    registry.removeMember(run, member.memberName);
    expect(registry.snapshot(run.teamName).members[member.memberName]).toMatchObject({
      membership: 'removed',
      process,
    });
    expect(registry.aliveTeamNames()).toEqual([]);
    expect(registry.aliveRunId(run.teamName)).toBeNull();
    expect(registry.observeExit(token, process, { code: 0, signal: null })).toBe(true);
  });

  it('returns frozen copies from the run lookup port', () => {
    const registry = setup();
    const snapshot = registry.find(run.teamName);
    expect(snapshot).not.toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.identity)).toBe(true);
    expect(Object.isFrozen(snapshot?.members)).toBe(true);
    expect(() => {
      (snapshot?.members.builder as { phase: string }).phase = 'ready';
    }).toThrow();
    expect(registry.find(run.teamName)?.members.builder.phase).toBe('stopped');
  });

  it('stamps the run start once and keeps it when the roster is configured', () => {
    let tick = 0;
    const registry = new MemberLifecycleRegistry(owner, () => `TEST-time-${++tick}`);
    const first = { ...run, teamName: 'test-first' };
    registry.beginPreparation(first);
    expect(registry.snapshot(first.teamName).startedAt).toBe('TEST-time-1');
    registry.configureTeam(first, [member]);
    expect(registry.snapshot(first.teamName).startedAt).toBe('TEST-time-1');
    const second = { ...run, teamName: 'test-second', runId: 'run-2' };
    registry.beginPreparation(second);
    expect(registry.snapshot(second.teamName).startedAt).toBe('TEST-time-2');
  });

  it('treats an adapter lane as liveness without inventing a member process', () => {
    const registry = setup();
    const token = start(registry, 'lane-start');
    const lane = {
      laneId: 'TEST-lane',
      sessionId: 'TEST-session',
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    };
    expect(registry.observeLane(token, lane)).toBe(true);
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'ready',
      process: null,
      lane,
      everConnected: true,
    });
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);
    expect(registry.aliveRunId(run.teamName)).toBe(run.runId);

    // A permission block revokes liveness but keeps the lane identity.
    expect(
      registry.observeLane(token, {
        ...lane,
        bootstrapConfirmed: false,
        permissionBlocked: true,
      })
    ).toBe(true);
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('connecting');
    expect(registry.aliveTeamNames()).toEqual([]);
    expect(registry.aliveRunId(run.teamName)).toBeNull();

    expect(
      registry.observeLane(token, { ...lane, bootstrapConfirmed: false, permissionBlocked: false })
    ).toBe(true);
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('ready');
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);

    expect(registry.observeLaneLost(token, 'TEST lane lost')).toBe(true);
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      lane: null,
      process: null,
      phase: 'exited',
      error: 'TEST lane lost',
    });
    expect(registry.aliveTeamNames()).toEqual([]);
    expect(registry.observeLaneLost(token)).toBe(false);
  });

  it('rejects lane evidence on a process member and process evidence on a lane member', () => {
    const registry = setup();
    const { token } = ready(registry);
    expect(
      registry.observeLane(token, {
        laneId: 'TEST-lane',
        sessionId: null,
        hostPid: null,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        permissionBlocked: false,
      })
    ).toBe(false);
    const laneRegistry = setup();
    const laneToken = start(laneRegistry, 'lane-start');
    laneRegistry.observeLane(laneToken, {
      laneId: 'TEST-lane',
      sessionId: null,
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    });
    expect(laneRegistry.observeSpawn(laneToken, { pid: 901, birthId: 'TEST-birth' })).toBe(false);
    expect(laneRegistry.snapshot(run.teamName).members.builder.process).toBeNull();
  });

  it('reaches ready when every configured member is a live lane', () => {
    const registry = setup();
    const tokens = registry.beginTeamStart(run, () => 'TEST-lane-op');
    for (const token of tokens) {
      registry.observeLane(token, {
        laneId: `TEST-lane-${token.memberName}`,
        sessionId: `TEST-session-${token.memberName}`,
        hostPid: 900,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        permissionBlocked: false,
      });
    }
    expect(registry.snapshot(run.teamName).state).toBe('ready');
    expect(registry.aliveTeamNames()).toEqual([run.teamName]);
    // A live lane still owns the team: it cannot be replaced by a new run.
    expect(() => registry.beginPreparation({ ...run, runId: 'run-2' })).toThrow(
      'Cannot replace an active team run'
    );
  });

  it('refuses a member release while its lane is still owned', () => {
    const registry = setup();
    const token = start(registry, 'lane-start');
    registry.observeLane(token, {
      laneId: 'TEST-lane',
      sessionId: null,
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    });
    expect(registry.observeMemberReleased(token)).toBe(false);
    expect(registry.observeLaneLost(token)).toBe(true);
    expect(registry.observeMemberReleased(token)).toBe(true);
  });

  it('treats a live lane member as already running and refuses process evidence', () => {
    const registry = setup();
    const token = start(registry, 'lane-start');
    registry.observeLane(token, {
      laneId: 'TEST-lane',
      sessionId: null,
      hostPid: 900,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      permissionBlocked: false,
    });
    expect(registry.beginStart(run, 'builder', 'lane-start-2')).toEqual({
      kind: 'already-running',
    });
    expect(registry.observeSpawn(token, { pid: 901, birthId: 'TEST-birth' })).toBe(false);
  });

  it('reports process loss after a successful connection, not a new pending join', () => {
    const registry = setup();
    const { token, process } = ready(registry);
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('ready');
    registry.observeExit(token, process, { code: 1, signal: null });
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'exited',
      desired: 'running',
      process: null,
      everConnected: true,
    });
  });

  it('projects aggregate readiness only from current processes, never historical connections', () => {
    const registry = setup();
    const tokens = registry.beginTeamStart(run, () => 'TEST-start');
    for (const [index, token] of tokens.entries()) {
      registry.observeSpawn(token, { pid: 200 + index, birthId: token.memberName });
      registry.observeConnected(token);
    }
    const connected = registry.snapshot(run.teamName);
    expect(connected.state).toBe('ready');
    const builder = tokens.find((token) => token.memberName === 'builder')!;
    registry.observeExit(builder, connected.members.builder.process!, { code: 1, signal: null });
    const lost = registry.snapshot(run.teamName);
    expect(lost.members.builder.everConnected).toBe(true);
    expect(lost.state).toBe('degraded');
    const lead = tokens.find((token) => token.memberName === 'team-lead')!;
    registry.observeExit(lead, connected.members['team-lead'].process!, { code: 1, signal: null });
    expect(registry.snapshot(run.teamName).state).toBe('failed');
    expect(registry.snapshot(run.teamName).version).toBe(lost.version + 1);
  });

  it('keeps process and resource failure distinct while intentional stop drains', () => {
    const registry = setup();
    const { token, process } = ready(registry);
    registry.requestTeamStop(run);
    registry.beginRelease(run);
    expect(registry.snapshot(run.teamName).state).toBe('stopping');
    registry.observeExit(token, process, { code: 0, signal: null });
    expect(registry.snapshot(run.teamName).state).toBe('stopping');
    expect(() => registry.observeReleased(run)).toThrow('Member resources');
    registry.observeMemberReleaseFailed(token);
    expect(registry.snapshot(run.teamName).state).toBe('release-failed');
    registry.observeMemberReleased(token);
    expect(registry.snapshot(run.teamName).state).toBe('stopping');
    registry.observeReleaseFailed(run, 'TEST native files still owned');
    expect(registry.snapshot(run.teamName).state).toBe('release-failed');
    registry.beginRelease(run);
    registry.observeReleased(run);
    expect(registry.snapshot(run.teamName).state).toBe('stopped');
  });

  it('returns the same operation for concurrent requests and never relaunches a ready member', () => {
    const registry = setup();
    const token = start(registry);
    expect(registry.beginStart(run, 'builder', 'start-2')).toMatchObject({
      kind: 'pending',
      token,
    });
    registry.observeSpawn(token, { pid: 123, birthId: 'birth-1' });
    registry.observeConnected(token);
    expect(registry.beginStart(run, 'builder', 'start-3').kind).toBe('already-running');
  });

  it('does not infer death or admit a duplicate from a stale heartbeat', () => {
    const registry = setup();
    const { token } = ready(registry);
    registry.observeConnectionLost(token);
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('unresponsive');
    expect(registry.beginStart(run, 'builder', 'start-2').kind).toBe('already-running');
  });

  it('rejects historical process events even after PID reuse', () => {
    const registry = setup();
    const first = ready(registry);
    registry.observeExit(first.token, first.process, { code: 1, signal: null });
    expect(registry.beginStart(run, 'builder', 'blocked').kind).toBe('stopping');
    expect(registry.recoveryCandidates(run.teamName)).toEqual([]);
    registry.observeMemberReleased(first.token);
    const second = start(registry, 'start-2');
    const nextProcess = { pid: first.process.pid, birthId: 'birth-2' };
    registry.observeSpawn(second, nextProcess);
    registry.observeConnected(second);
    const version = registry.snapshot(run.teamName).version;
    expect(registry.observeExit(first.token, first.process, { code: 1, signal: null })).toBe(false);
    expect(registry.observeExit(second, first.process, { code: 1, signal: null })).toBe(false);
    expect(registry.snapshot(run.teamName).version).toBe(version);
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('ready');
  });

  it('keeps intentional stop distinct from failure and refuses recovery after stop', () => {
    const registry = setup();
    const { token, process } = ready(registry);
    registry.requestStop(run, 'builder');
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('stopping');
    expect(registry.beginStart(run, 'builder', 'start-2').kind).toBe('stopping');
    registry.observeExit(token, process, { code: 0, signal: null });
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('stopped');
    expect(registry.recoveryCandidates(run.teamName)).toEqual([]);
  });

  it('does not launch unknown, removed, lead, foreign-team, or stale-run targets', () => {
    const registry = setup();
    expect(() => registry.beginStart(run, 'unknown', 's')).toThrow('not configured');
    expect(() => registry.beginStart(run, 'team-lead', 's')).toThrow('lead');
    expect(() => registry.beginStart({ ...run, teamName: 'other' }, 'builder', 's')).toThrow(
      'Unknown team'
    );
    expect(() => registry.beginStart({ ...run, runId: 'old-run' }, 'builder', 's')).toThrow(
      'stale'
    );
    registry.removeMember(run, 'builder');
    expect(() => registry.beginStart(run, 'builder', 's')).toThrow('removed');
  });

  it('does not expose mutable references or change version during reads', () => {
    const registry = setup();
    const before = registry.snapshot(run.teamName);
    const again = registry.snapshot(run.teamName);
    expect(again).toEqual(before);
    expect(again).not.toBe(before);
    expect(() => {
      (before.members.builder as { phase: string }).phase = 'ready';
    }).toThrow();
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('stopped');
  });

  it('rejects stale owner events and cannot replace an active run', () => {
    const registry = setup();
    const { token } = ready(registry);
    expect(registry.observeConnected({ ...token, appInstanceId: 'foreign-app' })).toBe(false);
    expect(() => registry.configureTeam({ ...run, runId: 'run-2' }, [member])).toThrow('active');
  });

  it('retains a runtime failure after exit but ignores an old attempt failure after replacement', () => {
    const registry = setup();
    const first = ready(registry);
    registry.observeRuntimeFailed(first.token, 'TEST registration failed');
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      process: first.process,
      error: 'TEST registration failed',
    });
    expect(registry.beginStart(run, 'builder', 'no-overlap').kind).toBe('already-running');
    registry.observeExit(first.token, first.process, { code: 1, signal: null });
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'failed',
      process: null,
    });
    registry.observeMemberReleased(first.token);
    const next = start(registry, 'TEST-next');
    expect(registry.observeMemberReleased(first.token)).toBe(false);
    expect(registry.observeMemberReleaseFailed(first.token)).toBe(false);
    expect(registry.observeRuntimeFailed(first.token, 'TEST late cleanup')).toBe(false);
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'starting',
      error: null,
      generation: next.generation,
    });
  });

  it('cancels a pending launch and retains stop ownership if spawn arrives late', () => {
    const registry = setup();
    const token = start(registry);
    registry.requestStop(run, 'builder');
    const process = { pid: 124, birthId: 'late-birth' };
    registry.observeSpawn(token, process);
    expect(registry.snapshot(run.teamName).members.builder).toMatchObject({
      phase: 'stopping',
      desired: 'stopped',
      process,
    });
    expect(registry.observeConnected(token)).toBe(false);
    registry.observeExit(token, process, { code: 0, signal: null });
    expect(registry.snapshot(run.teamName).members.builder.phase).toBe('stopped');
  });
});
