import { clearStaleProcessRuntimeMetadataFromMember } from '@main/services/team/provisioning/StaleProcessRuntimeMetadataCleanup';
import { validateMemberName } from '@main/services/team/TeamIdentifierValidation';
import { inspectProcessByPid } from '@main/utils/processInspection';

import { isNativeRuntimeProvider } from '../../infrastructure/nativeRuntimeProvider';
import { NativeTeamConfigStore } from '../../infrastructure/NativeTeamConfigStore';
import { isNativeTeamRunOwner } from '../../infrastructure/nativeTeamRunOwnership';

import type { TeamRunIdentity } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeTeamConfig } from '../../infrastructure/NativeTeamConfigStore';
import type { NodeTeamLaunchSettings } from './NodeTeamLaunchSettings';

interface Dependencies {
  teamsRoot: string;
  settings: Pick<NodeTeamLaunchSettings, 'runtimeConfiguration'>;
  invalidate(teamName: string): void;
}

function record(value: unknown): NativeTeamConfig | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as NativeTeamConfig)
    : null;
}

function rows(config: NativeTeamConfig | null): NativeTeamConfig[] {
  if (!config) return [];
  if (!Array.isArray(config.members)) throw new Error('Native team member projection is invalid');
  const names = new Set<string>();
  return config.members.map((value: unknown) => {
    const member = record(value);
    if (!member || typeof member.name !== 'string' || names.has(member.name))
      throw new Error('Native team member projection is invalid');
    names.add(member.name);
    return member;
  });
}

function toNativeMember(
  run: Readonly<TeamRunIdentity>,
  launch: Readonly<ConfiguredMemberLaunch>,
  color: string | undefined,
  joinedAt: number | undefined,
  previous: readonly NativeTeamConfig[]
): NativeTeamConfig {
  if (
    validateMemberName(launch.memberName).value !== launch.memberName ||
    !isNativeRuntimeProvider(launch.providerId)
  )
    throw new Error('Invalid native configured member');
  const member: NativeTeamConfig = {
    ...previous.find((row) => row.name === launch.memberName),
  };
  // Process/session/bootstrap fields belong only to the current attempt, never to saved membership.
  for (const key of Object.keys(member)) {
    if (
      /^(runtime|bootstrap|worktree)/.test(key) ||
      ['sessionId', 'isActive', 'removedAt', 'mode', 'tmuxPaneId', 'backendType'].includes(key)
    )
      delete member[key];
  }
  return {
    ...member,
    agentId: `${launch.memberName}@${run.teamName}`,
    name: launch.memberName,
    agentType: launch.role === 'lead' ? 'team-lead' : (launch.agentType ?? 'general-purpose'),
    provider: launch.providerId,
    providerId: launch.providerId,
    model: launch.model ?? undefined,
    effort: launch.effort,
    cwd: launch.workingDirectory,
    prompt: launch.instructions,
    color,
    joinedAt,
    tmuxPaneId: '',
    subscriptions: Array.isArray(member.subscriptions) ? member.subscriptions : [],
  };
}

function runtimeRow(member: NativeTeamConfig): NativeTeamConfig {
  const row: NativeTeamConfig = {};
  for (const [key, value] of Object.entries(member)) {
    if (
      /^(runtime|bootstrap|worktree)/.test(key) ||
      ['sessionId', 'isActive', 'removedAt', 'mode', 'tmuxPaneId', 'backendType'].includes(key)
    )
      row[key] = value;
  }
  return row;
}

function assertReleased(members: NativeTeamConfig[]): void {
  if (
    members.some(
      (member) =>
        member.runtimePid != null ||
        member.runtimeProcessBirthId != null ||
        member.runtimeOperationId != null ||
        (typeof member.tmuxPaneId === 'string' && member.tmuxPaneId.length > 0)
    )
  ) {
    throw new Error('Native team has an unreleased process projection');
  }
}

/** A legacy PID is not ownership: it may be gone or reused by an unrelated process. */
async function clearStaleLegacyProcessRows(
  members: NativeTeamConfig[],
  signal: AbortSignal
): Promise<void> {
  for (let index = 0; index < members.length; index++) {
    signal.throwIfAborted();
    const member = members[index];
    if (
      typeof member.runtimePid !== 'number' ||
      member.runtimeProcessBirthId != null ||
      member.runtimeOperationId != null
    )
      continue;
    const cleaned = clearStaleProcessRuntimeMetadataFromMember(member, {
      memberName: member.name as string,
      runtimePid: member.runtimePid,
      processPaneId: `process:${member.runtimePid}`,
    });
    if (!cleaned.changed) continue;
    const inspection = await inspectProcessByPid(member.runtimePid);
    signal.throwIfAborted();
    // Windows shell fallbacks quote/caret-escape flag tokens. Any team marker
    // is ambiguous ownership, not proof that a live PID belongs to someone else.
    if (
      inspection.status === 'not_found' ||
      (inspection.status === 'found' &&
        inspection.command.trim().length > 0 &&
        !inspection.command.includes('--team-name') &&
        !inspection.command.includes('--agent-id'))
    )
      members[index] = cleaned.member;
  }
}

/** Materializes configured identities; runtime files are never a source of configured membership. */
export class NodeNativeTeamConfig {
  private readonly store: NativeTeamConfigStore;

  constructor(private readonly ports: Dependencies) {
    this.store = new NativeTeamConfigStore(ports.teamsRoot);
  }

  async prepare(run: TeamRunIdentity, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const configured = await this.ports.settings.runtimeConfiguration(run);
    signal.throwIfAborted();
    await this.store.mutate(run.teamName, signal, async (current) => {
      if (current && (current.name !== run.teamName || current.deletedAt))
        throw new Error('Native team config is unavailable');
      const claim = record(current?.appManagedRun);
      if (claim) {
        if (
          !isNativeTeamRunOwner(claim.identity, run) ||
          claim.configurationRevision !== configured.configurationRevision
        ) {
          throw new Error('Native team config has another run owner');
        }
        return null;
      }
      if (current?.appManagedRun != null) throw new Error('Native team config owner is invalid');
      const previous = rows(current);
      await clearStaleLegacyProcessRows(previous, signal);
      assertReleased(previous);
      const leads = configured.members.filter(({ launch }) => launch.role === 'lead');
      if (leads.length !== 1) throw new Error('Native team config requires one configured lead');
      const members = configured.members.map(({ launch, color, joinedAt }) =>
        toNativeMember(run, launch, color, joinedAt, previous)
      );
      const config: NativeTeamConfig = {
        ...current,
        name: run.teamName,
        description: configured.description,
        createdAt: current?.createdAt ?? configured.createdAt,
        leadAgentId: `${leads[0].launch.memberName}@${run.teamName}`,
        members,
        appManagedRun: {
          identity: { ...run },
          configurationRevision: configured.configurationRevision,
        },
      };
      delete config.leadSessionId;
      return config;
    });
    this.ports.invalidate(run.teamName);
  }

  /**
   * Adds one already-configured member to the live projection without touching
   * the other members' runtime rows. Used by live roster attach.
   */
  async addMember(
    run: TeamRunIdentity,
    launch: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    signal.throwIfAborted();
    if (!isNativeTeamRunOwner(launch.team, run) || launch.memberName.trim() !== launch.memberName)
      throw new Error('Configured member does not belong to this run');
    if (launch.role === 'lead')
      throw new Error('Lead attach is not supported from member controls');
    const configured = await this.ports.settings.runtimeConfiguration(run);
    signal.throwIfAborted();
    const entry = configured.members.find(
      (member) => member.launch.memberName === launch.memberName
    );
    if (!entry) throw new Error('Configured member settings are unavailable');
    await this.store.mutate(run.teamName, signal, async (current) => {
      if (!current || current.name !== run.teamName || current.deletedAt)
        throw new Error('Native team config is unavailable');
      const claim = record(current.appManagedRun);
      if (!claim || !isNativeTeamRunOwner(claim.identity, run))
        throw new Error('Native team config has another run owner');
      const previous = rows(current);
      const saved = toNativeMember(run, entry.launch, entry.color, entry.joinedAt, previous);
      // A member update keeps the live attempt's runtime projection; the restart rewrites it.
      const existing = previous.find((member) => member.name === launch.memberName);
      return {
        ...current,
        members: existing
          ? previous.map((member) =>
              member.name === launch.memberName ? { ...saved, ...runtimeRow(existing) } : member
            )
          : [...previous, saved],
        appManagedRun: {
          ...claim,
          configurationRevision: launch.configurationRevision,
        },
      };
    });
    this.ports.invalidate(run.teamName);
  }

  async release(run: TeamRunIdentity): Promise<void> {
    await this.store.mutate(run.teamName, new AbortController().signal, async (current) => {
      if (!current) return null;
      const claim = record(current.appManagedRun);
      if (!claim) {
        if (current.appManagedRun != null) throw new Error('Native team config owner is invalid');
        return null;
      }
      if (!isNativeTeamRunOwner(claim.identity, run))
        throw new Error('Native team config has another run owner');
      assertReleased(rows(current));
      const next = { ...current };
      delete next.appManagedRun;
      return next;
    });
    this.ports.invalidate(run.teamName);
  }

  /**
   * Removes an `appManagedRun` marker whose run is not alive in this process.
   * Startup recovery calls it before a new launch; a live run keeps its claim.
   */
  async recoverOrphanedClaim(
    teamName: string,
    isRunAlive: (run: Readonly<TeamRunIdentity>) => boolean
  ): Promise<boolean> {
    let recovered = false;
    await this.store.mutate(teamName, new AbortController().signal, async (current) => {
      if (!current) return null;
      const claim = record(current.appManagedRun);
      if (!claim) {
        if (current.appManagedRun != null) throw new Error('Native team config owner is invalid');
        return null;
      }
      const identity = record(claim.identity);
      if (!identity) throw new Error('Native team config owner is invalid');
      if (isRunAlive(identity as unknown as Readonly<TeamRunIdentity>)) return null;
      recovered = true;
      const next = { ...current };
      delete next.appManagedRun;
      return next;
    });
    if (recovered) this.ports.invalidate(teamName);
    return recovered;
  }
}
