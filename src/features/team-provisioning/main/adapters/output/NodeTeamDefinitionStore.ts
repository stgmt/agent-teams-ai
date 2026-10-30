import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import {
  parseCreateTeamRequest,
  parseProviderBackendId,
} from '@main/services/team/TeamRequestValidation';
import { applyDistinctRosterColors } from '@main/services/team/teamRosterColors';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaFile, TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type {
  EffortLevel,
  TeamCreateConfigRequest,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';
import type { Stats } from 'node:fs';

const EFFORT_LEVELS = new Set<string>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
const FAST_MODES = new Set<string>(['inherit', 'on', 'off']);

interface Dependencies {
  teamsRoot: string;
  tasksRoot: string;
  metadata: Pick<TeamMetaStore, 'serializeMeta' | 'updateMeta'>;
  members: Pick<TeamMembersMetaStore, 'serializeMembers'>;
  invalidate(): void;
}

/** Launch fields the UI may change without rewriting the roster. */
export interface TeamLaunchSettingsUpdate {
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamFastMode;
  syncModelsWithLead?: boolean;
  limitContext?: boolean;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
}

function validated(request: TeamCreateConfigRequest): TeamCreateConfigRequest {
  const parsed = parseCreateTeamRequest({ ...request, runtimeSelectionVersion: 1 });
  // The existing serializer accepts obsolete backend aliases. New definitions do not.
  for (const [raw, normalized] of [
    [request, parsed],
    ...request.members.map((member, index) => [member, parsed.members[index]]),
  ]) {
    if (raw.providerBackendId && raw.providerBackendId !== normalized.providerBackendId) {
      throw new Error('Configured provider backend is not valid for this provider');
    }
  }
  return parsed;
}

/** A canonical definition already exists; the caller may reuse its saved roster. */
export class TeamDefinitionExistsError extends Error {
  constructor(teamName: string) {
    super(`Team already exists: ${teamName}`);
    this.name = 'TeamDefinitionExistsError';
  }
}

/** Creates canonical intent only. Runtime config is materialized by the admitted launch command. */
export class NodeTeamDefinitionStore {
  constructor(private readonly ports: Dependencies) {}

  async create(input: TeamCreateConfigRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const request = validated(input);
    const createdAt = Date.now();
    const members: TeamMember[] = applyDistinctRosterColors(
      request.members.map((member) => ({
        ...member,
        agentType: 'general-purpose',
        joinedAt: createdAt,
      }))
    );
    const metaText = this.ports.metadata.serializeMeta({
      ...request,
      cwd: request.cwd ?? '',
      createdAt,
    });
    const membersText = this.ports.members.serializeMembers(members, request);
    const teamDirectory = join(this.ports.teamsRoot, request.teamName);
    const tasksDirectory = join(this.ports.tasksRoot, request.teamName);
    const owned: { path: string; identity: Stats; directory: boolean }[] = [];
    const createDirectory = async (path: string): Promise<void> => {
      signal.throwIfAborted();
      await fs.mkdir(path, { mode: 0o700 });
      owned.push({ path, identity: await fs.lstat(path), directory: true });
    };
    const createFile = async (path: string, text: string): Promise<void> => {
      signal.throwIfAborted();
      const handle = await fs.open(path, 'wx', 0o600);
      try {
        owned.push({ path, identity: await handle.stat(), directory: false });
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
    };
    for (const root of [this.ports.teamsRoot, this.ports.tasksRoot]) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Team definition root must not be redirected');
    }
    try {
      await createDirectory(teamDirectory);
      await createDirectory(tasksDirectory);
      await createDirectory(join(teamDirectory, 'inboxes'));
      await createFile(join(teamDirectory, 'team.meta.json'), metaText);
      await createFile(join(teamDirectory, 'members.meta.json'), membersText);
      signal.throwIfAborted();
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of owned.toReversed()) {
        try {
          const current = await fs.lstat(entry.path);
          if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino)
            throw new Error('Team definition path ownership changed');
          // Never recursively remove a public directory: another writer's data must survive.
          for (let attempt = 0; ; attempt++) {
            try {
              if (entry.directory) await fs.rmdir(entry.path);
              else await fs.unlink(entry.path);
              break;
            } catch (cleanupError) {
              if (
                attempt >= 20 ||
                !['EBUSY', 'EPERM', 'EACCES'].includes(
                  (cleanupError as NodeJS.ErrnoException).code ?? ''
                )
              )
                throw cleanupError;
              await delay(250);
            }
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          'Team definition creation failed; owned cleanup is incomplete'
        );
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new TeamDefinitionExistsError(request.teamName);
      throw error;
    }
    this.ports.invalidate();
  }

  /**
   * Persists the launch request into the canonical definition before launch.
   * Omitted fields keep their saved value; changing the provider drops values
   * that belong to the previous provider and a saved resolved-model cache.
   */
  async updateLaunchSettings(
    teamName: string,
    update: TeamLaunchSettingsUpdate,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    const validatedName = validateTeamName(teamName);
    if (!validatedName.valid || validatedName.value !== teamName)
      throw new Error('Invalid canonical team name');
    if (!isAbsolute(update.cwd))
      throw new Error('An absolute launch working directory is required');
    if (
      update.providerId !== undefined &&
      normalizeOptionalTeamProviderId(update.providerId) !== update.providerId
    )
      throw new Error('Configured provider is not valid');
    if (update.effort !== undefined && !EFFORT_LEVELS.has(update.effort))
      throw new Error('Configured effort is not valid');
    if (update.fastMode !== undefined && !FAST_MODES.has(update.fastMode))
      throw new Error('Configured fast mode is not valid');
    await this.ports.metadata.updateMeta(
      teamName,
      (meta) => {
        if (!meta || meta.deletedAt) throw new Error('Canonical team metadata is unavailable');
        const providerId = update.providerId ?? meta.providerId;
        const providerChanged =
          update.providerId !== undefined && update.providerId !== meta.providerId;
        const providerBackendId = parseProviderBackendId(
          providerId,
          update.providerBackendId !== undefined
            ? update.providerBackendId
            : providerChanged
              ? undefined
              : meta.providerBackendId
        );
        const backendChanged = providerBackendId !== meta.providerBackendId;
        const { launchIdentity, ...persisted } = meta;
        const next: Omit<TeamMetaFile, 'version'> = { ...persisted, cwd: update.cwd };
        if (providerChanged) {
          // Provider-scoped values cannot survive a provider switch.
          delete next.model;
          delete next.effort;
          delete next.fastMode;
        } else if (
          launchIdentity &&
          !backendChanged &&
          update.model === undefined &&
          update.effort === undefined
        ) {
          next.launchIdentity = launchIdentity;
        }
        if (update.prompt !== undefined) next.prompt = update.prompt;
        if (providerId !== undefined) next.providerId = providerId;
        if (providerBackendId !== undefined) next.providerBackendId = providerBackendId;
        if (update.model !== undefined) next.model = update.model;
        if (update.effort !== undefined) next.effort = update.effort;
        if (update.fastMode !== undefined) next.fastMode = update.fastMode;
        if (update.syncModelsWithLead !== undefined)
          next.syncModelsWithLead = update.syncModelsWithLead;
        if (update.limitContext !== undefined) next.limitContext = update.limitContext;
        if (update.skipPermissions !== undefined) next.skipPermissions = update.skipPermissions;
        if (update.worktree !== undefined) next.worktree = update.worktree;
        if (update.extraCliArgs !== undefined) next.extraCliArgs = update.extraCliArgs;
        return next;
      },
      this.ports.teamsRoot
    );
    this.ports.invalidate();
  }
}
