import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { buildEffectiveTeamMemberSpec } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import { resolveTeamSpecScope } from '@main/services/team/registry/TeamSpecBinding';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { isCanonicalSettingsLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { fingerprintSavedLaunchSettings } from '../../../contracts';
import { awaitWithAbort } from '../../../core/application/awaitWithAbort';

import type { ConfiguredMemberIdentity, TeamRunIdentity } from '../../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaunchSettingsPort,
} from '../../../core/application/ports/MemberRuntimePorts';
import type {
  PreparedTeamWorkspace,
  TeamWorkspacePort,
} from '../../../core/application/ports/TeamWorkspacePorts';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile, TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type {
  TeamCreateRequest,
  TeamMember,
  TeamMemberMcpPolicy,
  TeamSpecScope,
} from '@shared/types';

interface Dependencies {
  teamsRoot: string;
  metadata: Pick<TeamMetaStore, 'getMeta'>;
  members: Pick<TeamMembersMetaStore, 'getMeta'>;
  /**
   * Registry endpoint and token for the spec MCP the agents inherit. Resolved by
   * the composition root; absent when no registry credential is configured.
   */
  specRegistryEnvironment?: () => Promise<Readonly<Record<string, string>> | null>;
}

interface CapturedTeam {
  runKey: string;
  configurationRevision: string;
  members: readonly Readonly<ConfiguredMemberIdentity>[];
  /** Team metadata fingerprint at admission; attach must not launder unrelated drift. */
  metaFingerprint: string;
  /** Per-member saved-settings fingerprints; only the attached member may differ. */
  memberFingerprints: Readonly<Record<string, string>>;
}

export interface ConfiguredNativeTeam {
  configurationRevision: string;
  createdAt: number;
  description?: string;
  members: readonly {
    launch: Readonly<ConfiguredMemberLaunch>;
    color?: string;
    joinedAt: number;
  }[];
}

function runKey(run: TeamRunIdentity): string {
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
  ]);
}

function frozenMcpPolicy(policy: TeamMemberMcpPolicy | undefined): TeamMemberMcpPolicy | undefined {
  if (!policy) return undefined;
  const serverNames = policy.serverNames ? [...policy.serverNames] : undefined;
  if (serverNames) Object.freeze(serverNames);
  return Object.freeze({
    ...policy,
    scopes: policy.scopes ? Object.freeze({ ...policy.scopes }) : undefined,
    serverNames,
  });
}

function memberFingerprint(member: TeamMember): string {
  return JSON.stringify([
    member.name,
    member.role,
    member.agentType,
    member.workflow,
    member.isolation,
    member.cwd,
    member.providerId,
    member.providerBackendId,
    member.model,
    member.effort,
    member.fastMode,
    member.mcpPolicy && [
      member.mcpPolicy.mode,
      member.mcpPolicy.serverNames,
      member.mcpPolicy.scopes &&
        Object.entries(member.mcpPolicy.scopes).sort(([a], [b]) => a.localeCompare(b)),
    ],
  ]);
}

function fingerprints(members: readonly TeamMember[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const member of members)
    if (!member.removedAt) result[member.name] = memberFingerprint(member);
  return Object.freeze(result);
}

function revision(meta: TeamMetaFile, members: readonly TeamMember[]): string {
  const configured = members
    .filter((member) => !member.removedAt)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((member) => [
      member.name,
      member.role,
      member.agentType,
      member.workflow,
      member.isolation,
      member.cwd,
      member.providerId,
      member.providerBackendId,
      member.model,
      member.effort,
      member.fastMode,
      member.mcpPolicy && [
        member.mcpPolicy.mode,
        member.mcpPolicy.serverNames,
        member.mcpPolicy.scopes &&
          Object.entries(member.mcpPolicy.scopes).sort(([a], [b]) => a.localeCompare(b)),
      ],
    ]);
  return createHash('sha256')
    .update(JSON.stringify([fingerprintSavedLaunchSettings(meta), configured]))
    .digest('hex');
}

function renderSpecBindingInstructions(scope: Readonly<TeamSpecScope>): string {
  return [
    '## Specification workflow',
    'The registry is the authority for specifications, design, roadmaps and tasks.',
    'Use the mounted specification MCP tools and their current schemas for the full requirements → design → execution → review lifecycle.',
    'Do not read or write the specification corpus through local files or another plugin.',
    'Permitted registry projects:',
    ...scope.projects.map((project) => `- ${project}`),
    'Bound specifications:',
    ...scope.bindings.map((binding) => `- ${binding.project} / ${binding.spec}`),
    ...(!scope.bindings.length
      ? ['Create the first specification in a permitted project through the registry tools.']
      : []),
    'Use the supplied project scope; creating a specification never widens project access.',
    'Read the available tool schemas before invoking a capability; never invent tool names or fields.',
  ].join('\n');
}

export class NodeTeamLaunchSettings implements MemberLaunchSettingsPort {
  private readonly captured = new Map<string, Readonly<CapturedTeam>>();
  private readonly detachCancellation = new Map<string, () => void>();
  private readonly workspaces = new Map<Readonly<CapturedTeam>, Readonly<PreparedTeamWorkspace>>();

  private readonly teamsRoot: string;

  constructor(private readonly ports: Dependencies) {
    if (!isAbsolute(ports.teamsRoot)) throw new Error('Canonical teams root must be absolute');
    this.teamsRoot = ports.teamsRoot;
  }

  async capture(
    run: TeamRunIdentity,
    signal: AbortSignal = new AbortController().signal
  ): Promise<Readonly<CapturedTeam>> {
    signal.throwIfAborted();
    const { meta, members } = await awaitWithAbort(this.read(run.teamName), signal);
    signal.throwIfAborted();
    const previous = this.captured.get(run.teamName);
    if (previous) {
      if (previous.runKey !== runKey(run))
        throw new Error('Team run settings are already captured');
      if (previous.configurationRevision !== revision(meta, members))
        throw new Error('Canonical team launch settings changed after admission');
      return previous;
    }
    const active = this.validatedRoster(members);
    const captured = Object.freeze({
      runKey: runKey(run),
      configurationRevision: revision(meta, members),
      members: Object.freeze(
        active.map((member) =>
          Object.freeze({
            memberName: member.name,
            role: isCanonicalSettingsLeadMember(member) ? ('lead' as const) : ('member' as const),
          })
        )
      ),
      metaFingerprint: fingerprintSavedLaunchSettings(meta),
      memberFingerprints: fingerprints(active),
    });
    this.captured.set(run.teamName, captured);
    const cancel = (): void => this.release(run);
    signal.addEventListener('abort', cancel, { once: true });
    this.detachCancellation.set(run.teamName, () => signal.removeEventListener('abort', cancel));
    return captured;
  }

  /** Restore only persisted workspace authority; never allocate Git or replay launch/bootstrap. */
  async restore(
    run: TeamRunIdentity,
    workspace: Readonly<PreparedTeamWorkspace>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<void> {
    signal.throwIfAborted();
    if (
      !isAbsolute(workspace.workingDirectory) ||
      (workspace.worktree &&
        (!isAbsolute(workspace.worktree.baseRepoPath) || !workspace.worktree.branchName.trim()))
    )
      throw new Error('Invalid persisted team workspace');
    const previous = this.captured.get(run.teamName);
    const captured = await this.capture(run, signal);
    try {
      const { meta, members } = await this.read(run.teamName);
      signal.throwIfAborted();
      if (revision(meta, members) !== captured.configurationRevision)
        throw new Error('Canonical team launch settings changed during restoration');
      if (meta.worktree !== undefined && !workspace.worktree)
        throw new Error('Persisted team worktree context is missing');
      if (this.captured.get(run.teamName) !== captured)
        throw new Error('Team run settings were not captured');
      this.workspaces.set(
        captured,
        Object.freeze({
          workingDirectory: workspace.workingDirectory,
          ...(workspace.worktree ? { worktree: Object.freeze({ ...workspace.worktree }) } : {}),
        })
      );
    } catch (error) {
      if (!previous && this.captured.get(run.teamName) === captured) this.release(run);
      throw error;
    }
  }

  async prepareWorkspace(
    run: TeamRunIdentity,
    workspace: TeamWorkspacePort,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    const captured = this.captured.get(run.teamName);
    if (captured?.runKey !== runKey(run)) throw new Error('Team run settings were not captured');
    const { meta, members } = await this.read(run.teamName);
    if (revision(meta, members) !== captured.configurationRevision)
      throw new Error('Canonical team launch settings changed after admission');
    signal.throwIfAborted();
    if (!meta.cwd) throw new Error('Configured team working directory is required');
    // Allocation mutates Git; cancellation must physically drain it before releasing the run.
    const prepared = await workspace.prepareTeam(
      Object.freeze({
        teamName: run.teamName,
        workingDirectory: meta.cwd,
        worktreeName: meta.worktree,
      }),
      signal
    );
    signal.throwIfAborted();
    if (this.captured.get(run.teamName) !== captured)
      throw new Error('Team run settings were not captured');
    const current = await this.read(run.teamName);
    signal.throwIfAborted();
    if (this.captured.get(run.teamName) !== captured)
      throw new Error('Team run settings were not captured');
    if (revision(current.meta, current.members) !== captured.configurationRevision)
      throw new Error('Canonical team launch settings changed after admission');
    if (
      !isAbsolute(prepared.workingDirectory) ||
      (meta.worktree !== undefined && !prepared.worktree)
    )
      throw new Error('Configured team workspace was not prepared');
    this.workspaces.set(
      captured,
      Object.freeze({
        workingDirectory: prepared.workingDirectory,
        ...(prepared.worktree ? { worktree: Object.freeze({ ...prepared.worktree }) } : {}),
      })
    );
  }

  async admitConfiguredMember(run: TeamRunIdentity, memberName: string): Promise<void> {
    const captured = this.captured.get(run.teamName);
    if (captured?.runKey !== runKey(run)) throw new Error('Team run settings were not captured');
    const { meta, members } = await this.read(run.teamName);
    // A concurrent stop must not be resurrected by a write that started before it.
    if (this.captured.get(run.teamName) !== captured)
      throw new Error('Team run settings were not captured');
    const member = members.find((entry) => !entry.removedAt && entry.name === memberName);
    if (!member) throw new Error(`Member "${memberName}" is not configured`);
    const active = this.validatedRoster(members);
    if (fingerprintSavedLaunchSettings(meta) !== captured.metaFingerprint)
      throw new Error('Canonical team launch settings changed after admission');
    const current = fingerprints(active);
    // Only the attached member may drift; every other member stays as admitted.
    for (const [name, fingerprint] of Object.entries(captured.memberFingerprints)) {
      if (name !== memberName && current[name] !== fingerprint)
        throw new Error('Canonical team launch settings changed after admission');
    }
    const next = Object.freeze({
      runKey: captured.runKey,
      configurationRevision: revision(meta, members),
      members: Object.freeze(
        active.map((entry) =>
          Object.freeze({
            memberName: entry.name,
            role: isCanonicalSettingsLeadMember(entry) ? ('lead' as const) : ('member' as const),
          })
        )
      ),
      metaFingerprint: fingerprintSavedLaunchSettings(meta),
      memberFingerprints: current,
    });
    if (this.captured.get(run.teamName) !== captured)
      throw new Error('Team run settings were not captured');
    // The prepared workspace is keyed by the capture object; carry it to the rebased capture.
    const workspace = this.workspaces.get(captured);
    this.captured.set(run.teamName, next);
    if (workspace) {
      this.workspaces.delete(captured);
      this.workspaces.set(next, workspace);
    }
  }

  async findConfiguredMember(
    run: TeamRunIdentity,
    memberName: string
  ): Promise<ConfiguredMemberLaunch | null> {
    const captured = this.captured.get(run.teamName);
    if (captured?.runKey !== runKey(run)) throw new Error('Team run settings were not captured');
    const { meta, members } = await this.read(run.teamName);
    if (revision(meta, members) !== captured.configurationRevision) {
      throw new Error('Canonical team launch settings changed after admission');
    }
    const member = this.withConfiguredLead(members).find((entry) => entry.name === memberName);
    if (!member) return null;
    const integration = await this.resolveSpecIntegration(meta);
    return this.resolveMember(run, captured, meta, member, integration);
  }

  async runtimeConfiguration(run: TeamRunIdentity): Promise<Readonly<ConfiguredNativeTeam>> {
    const captured = this.captured.get(run.teamName);
    if (captured?.runKey !== runKey(run)) throw new Error('Team run settings were not captured');
    const { meta, members } = await this.read(run.teamName);
    if (revision(meta, members) !== captured.configurationRevision) {
      throw new Error('Canonical team launch settings changed after admission');
    }
    const integration = await this.resolveSpecIntegration(meta);
    return Object.freeze({
      configurationRevision: captured.configurationRevision,
      createdAt: meta.createdAt,
      description: meta.description,
      members: Object.freeze(
        this.withConfiguredLead(members).map((member) =>
          Object.freeze({
            launch: this.resolveMember(run, captured, meta, member, integration),
            color: member.color,
            joinedAt: member.joinedAt ?? meta.createdAt,
          })
        )
      ),
    });
  }

  private resolveMember(
    run: TeamRunIdentity,
    captured: Readonly<CapturedTeam>,
    meta: TeamMetaFile,
    member: TeamMember,
    specIntegration: ConfiguredMemberLaunch['specIntegration']
  ): Readonly<ConfiguredMemberLaunch> {
    const lead = isCanonicalSettingsLeadMember(member);
    const effective = lead
      ? {
          ...member,
          providerId: meta.providerId,
          providerBackendId: meta.providerBackendId,
          model: meta.model,
          effort: meta.effort as TeamCreateRequest['effort'],
        }
      : buildEffectiveTeamMemberSpec(member, {
          providerId: meta.providerId,
          model: meta.model,
          effort: meta.effort as TeamCreateRequest['effort'],
          syncModelsWithLead: meta.syncModelsWithLead,
        });
    const specInstructions = renderSpecBindingInstructions(specIntegration.scope);
    const providerId = normalizeOptionalTeamProviderId(effective.providerId);
    if (!providerId) throw new Error('Configured member provider is required');
    const workspace = this.workspaces.get(captured);
    if (meta.worktree !== undefined && !workspace)
      throw new Error('Configured team workspace was not prepared');
    const baseWorkingDirectory = workspace?.workingDirectory ?? meta.cwd;
    const workingDirectory = member.cwd?.trim() || baseWorkingDirectory;
    if (!workingDirectory?.trim())
      throw new Error('Configured member working directory is required');
    return Object.freeze({
      team: Object.freeze({ ...run }),
      memberName: member.name,
      role: lead ? 'lead' : 'member',
      agentType: member.agentType,
      mcpPolicy: frozenMcpPolicy(member.mcpPolicy),
      configurationRevision: captured.configurationRevision,
      providerId,
      providerBackendId: effective.providerBackendId,
      model: effective.model ?? null,
      effort: effective.effort,
      fastMode:
        member.fastMode === 'on' || member.fastMode === 'off' ? member.fastMode : meta.fastMode,
      skipPermissions: meta.skipPermissions !== false,
      limitContext: meta.limitContext === true,
      extraCliArgs: meta.extraCliArgs,
      specIntegration,
      workingDirectory,
      baseWorkingDirectory,
      worktree: !member.cwd?.trim() ? workspace?.worktree : undefined,
      isolation: member.isolation,
      // The lead is launched from `instructions`, so the recipe rides with it.
      // Members get their briefing from the app-managed bootstrap text; the
      // recipe reaches them through `specInstructions` in the briefing builder.
      instructions: lead
        ? [meta.prompt ?? '', specInstructions ?? ''].filter((part) => part.trim()).join('\n\n')
        : [member.role, member.workflow].filter(Boolean).join('\n\n'),
      ...(specInstructions ? { specInstructions } : {}),
    });
  }

  private async resolveSpecIntegration(
    meta: TeamMetaFile
  ): Promise<ConfiguredMemberLaunch['specIntegration']> {
    const scope = resolveTeamSpecScope(meta);
    Object.freeze(scope.projects);
    scope.bindings.forEach(Object.freeze);
    Object.freeze(scope.bindings);
    const resolve = this.ports.specRegistryEnvironment;
    if (!resolve) throw new Error('Specification registry credential resolver is required');
    const environment = await resolve();
    const url = environment?.OMP_SPEC_REGISTRY_URL?.trim();
    const token = environment?.OMP_SPEC_REGISTRY_TOKEN?.trim();
    if (!url || !token)
      throw new Error('Specification registry endpoint and credential are required');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
      throw new Error('Invalid specification registry endpoint');
    return Object.freeze({
      scope: Object.freeze({
        projects: scope.projects,
        bindings: scope.bindings,
      }),
      environment: Object.freeze({
        ...environment,
        OMP_SPEC_REGISTRY_URL: url,
        OMP_SPEC_REGISTRY_TOKEN: token,
      }),
    });
  }

  release(run: TeamRunIdentity): void {
    if (this.captured.get(run.teamName)?.runKey === runKey(run)) {
      this.detachCancellation.get(run.teamName)?.();
      this.detachCancellation.delete(run.teamName);
      const captured = this.captured.get(run.teamName);
      if (captured) this.workspaces.delete(captured);
      this.captured.delete(run.teamName);
    }
  }

  private validatedRoster(members: readonly TeamMember[]): TeamMember[] {
    const active = this.withConfiguredLead(members);
    if (active.filter(isCanonicalSettingsLeadMember).length !== 1) {
      throw new Error('Canonical team roster must contain exactly one lead');
    }
    const names = new Set<string>();
    for (const member of active) {
      if (!member.name.trim() || member.name !== member.name.trim() || names.has(member.name)) {
        throw new Error('Canonical team roster contains an invalid or duplicate member');
      }
      names.add(member.name);
    }
    return active;
  }

  private withConfiguredLead(members: readonly TeamMember[]): TeamMember[] {
    const active = members.filter((member) => !member.removedAt);
    // Team-level metadata owns lead settings; the canonical member list contains teammates.
    return active.some(isCanonicalSettingsLeadMember)
      ? active
      : [{ name: 'team-lead', agentType: 'team-lead' }, ...active];
  }

  private async read(teamName: string): Promise<{ meta: TeamMetaFile; members: TeamMember[] }> {
    const validatedName = validateTeamName(teamName);
    if (!validatedName.valid || validatedName.value !== teamName)
      throw new Error('Invalid canonical team name');
    const [meta, roster] = await Promise.all([
      this.ports.metadata.getMeta(teamName, this.teamsRoot, { requireCompleteFields: true }),
      this.ports.members.getMeta(teamName, {
        requireCompleteMembers: true,
        teamsBasePath: this.teamsRoot,
      }),
    ]);
    if (!meta || meta.deletedAt) throw new Error('Canonical team metadata is unavailable');
    if (!roster) throw new Error('Canonical member metadata is unavailable');
    if (!normalizeOptionalTeamProviderId(meta.providerId))
      throw new Error('A team provider must be explicitly configured');
    resolveTeamSpecScope(meta, teamName);
    return { meta, members: roster.members };
  }
}
