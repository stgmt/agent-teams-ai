import { validateMemberName } from '@main/services/team/TeamIdentifierValidation';

import { isNativeRuntimeProvider } from '../../infrastructure/nativeRuntimeProvider';
import { NativeTeamConfigStore } from '../../infrastructure/NativeTeamConfigStore';
import { isNativeTeamRunOwner } from '../../infrastructure/nativeTeamRunOwnership';

import type { TeamRunIdentity } from '../../../contracts';
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
      assertReleased(previous);
      const leads = configured.members.filter(({ launch }) => launch.role === 'lead');
      if (leads.length !== 1) throw new Error('Native team config requires one configured lead');
      const members = configured.members.map(({ launch, color, joinedAt }) => {
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
            ['sessionId', 'isActive', 'removedAt', 'mode', 'tmuxPaneId', 'backendType'].includes(
              key
            )
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
      });
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
