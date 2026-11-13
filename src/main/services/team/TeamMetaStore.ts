import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeProviderBillingMode } from '@shared/utils/providerBillingMode';
import { normalizeRuntimeSelectionVersion } from '@shared/utils/teamRuntimeSelection';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { resolveTeamSpecScope } from './registry/TeamSpecBinding';
import { migrateTeamSpecScope } from './registry/TeamSpecBindingMigration';
import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { hasCompleteKnownMetadata } from './TeamMetadataReadFidelity';
import { MAX_TEAM_METADATA_BYTES, serializeTeamMetadata } from './TeamMetadataSerialization';

import type {
  ProviderModelLaunchIdentity,
  RegistryRegistrationIdentity,
  TeamFastMode,
  TeamProviderId,
  TeamSpecScope,
} from '@shared/types';

/**
 * Persisted team-level metadata saved by the UI before CLI provisioning.
 * CLI does not know about this file — it only reads/writes config.json.
 * If provisioning fails before TeamCreate, this file preserves user's
 * configuration for retry.
 */
export interface TeamMetaFile {
  version: 1;
  runtimeSelectionVersion?: 1;
  deletedAt?: string;
  registryTeamId?: string;
  registryRegistrationRequestId?: string;
  registryRegistrationProject?: string;
  registryRegistrationProtocol?: 1;
  registryRegistrationIdentity?: RegistryRegistrationIdentity;
  registryRegistrationCompleted?: boolean;
  specScope?: TeamSpecScope;
  displayName?: string;
  description?: string;
  color?: string;
  cwd: string;
  prompt?: string;
  providerId?: TeamProviderId;
  providerBackendId?: string;
  model?: string;
  effort?: string;
  fastMode?: TeamFastMode;
  syncModelsWithLead?: boolean;
  skipPermissions?: boolean;
  worktree?: string;
  extraCliArgs?: string;
  limitContext?: boolean;
  launchIdentity?: ProviderModelLaunchIdentity;
  createdAt: number;
}

const metaMutationLocks = new Map<string, Promise<void>>();

async function withMetaMutationLock<T>(
  pathKey: string,
  operation: () => Promise<T>,
  createParent = true
): Promise<T> {
  const previous = metaMutationLocks.get(pathKey);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  metaMutationLocks.set(pathKey, current);
  if (previous) await previous;
  try {
    return await withFileLock(pathKey, operation, { preventLiveOwnerTakeover: true, createParent });
  } finally {
    release();
    if (metaMutationLocks.get(pathKey) === current) metaMutationLocks.delete(pathKey);
  }
}

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProviderId(value: unknown): TeamProviderId | undefined {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode'
    ? value
    : undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeRegistrationIdentity(value: unknown): RegistryRegistrationIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const exact = (item: unknown): item is string =>
    typeof item === 'string' && item.length > 0 && item === item.trim();
  if (!exact(record.securityStoreId) || !exact(record.idp) || !exact(record.userId))
    return undefined;
  return { securityStoreId: record.securityStoreId, idp: record.idp, userId: record.userId };
}

function registrationIdentitiesEqual(
  a: RegistryRegistrationIdentity,
  b: RegistryRegistrationIdentity
): boolean {
  return a.securityStoreId === b.securityStoreId && a.idp === b.idp && a.userId === b.userId;
}

function normalizeFastMode(value: unknown): TeamFastMode | null {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : null;
}

function normalizeLaunchIdentity(value: unknown): ProviderModelLaunchIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const raw = value as Partial<ProviderModelLaunchIdentity>;
  const providerId = normalizeProviderId(raw.providerId);
  const selectedModelKind =
    raw.selectedModelKind === 'default' || raw.selectedModelKind === 'explicit'
      ? raw.selectedModelKind
      : null;
  if (!providerId || !selectedModelKind) {
    return undefined;
  }

  const catalogSource =
    raw.catalogSource === 'anthropic-models-api' ||
    raw.catalogSource === 'anthropic-compatible-api' ||
    raw.catalogSource === 'app-server' ||
    raw.catalogSource === 'static-fallback' ||
    raw.catalogSource === 'runtime' ||
    raw.catalogSource === 'unavailable'
      ? raw.catalogSource
      : 'unavailable';
  const selectedEffort =
    raw.selectedEffort === 'none' ||
    raw.selectedEffort === 'minimal' ||
    raw.selectedEffort === 'low' ||
    raw.selectedEffort === 'medium' ||
    raw.selectedEffort === 'high' ||
    raw.selectedEffort === 'xhigh' ||
    raw.selectedEffort === 'max' ||
    raw.selectedEffort === 'ultra'
      ? raw.selectedEffort
      : null;
  const resolvedEffort =
    raw.resolvedEffort === 'none' ||
    raw.resolvedEffort === 'minimal' ||
    raw.resolvedEffort === 'low' ||
    raw.resolvedEffort === 'medium' ||
    raw.resolvedEffort === 'high' ||
    raw.resolvedEffort === 'xhigh' ||
    raw.resolvedEffort === 'max' ||
    raw.resolvedEffort === 'ultra'
      ? raw.resolvedEffort
      : null;

  return {
    providerId,
    providerBackendId:
      migrateProviderBackendId(providerId, normalizeOptionalString(raw.providerBackendId)) ?? null,
    billingMode: normalizeProviderBillingMode(raw.billingMode),
    selectedModel: normalizeOptionalString(raw.selectedModel),
    selectedModelKind,
    resolvedLaunchModel: normalizeOptionalString(raw.resolvedLaunchModel),
    catalogId: normalizeOptionalString(raw.catalogId),
    catalogSource,
    catalogFetchedAt: normalizeOptionalString(raw.catalogFetchedAt),
    selectedEffort,
    resolvedEffort,
    selectedFastMode: normalizeFastMode(raw.selectedFastMode),
    resolvedFastMode: typeof raw.resolvedFastMode === 'boolean' ? raw.resolvedFastMode : null,
    fastResolutionReason: normalizeOptionalString(raw.fastResolutionReason),
  };
}

export class TeamMetaStore {
  private getMetaPath(teamName: string, teamsBasePath = getTeamsBasePath()): string {
    return path.join(teamsBasePath, teamName, 'team.meta.json');
  }

  async getMeta(
    teamName: string,
    teamsBasePath = getTeamsBasePath(),
    options?: { requireCompleteFields?: boolean; skipScopeMigration?: boolean }
  ): Promise<TeamMetaFile | null> {
    const metaPath = this.getMetaPath(teamName, teamsBasePath);
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile() || stat.size > MAX_TEAM_METADATA_BYTES) {
        return null;
      }
    } catch {
      return null;
    }

    let raw: string;
    try {
      raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        error instanceof FileReadTimeoutError
      ) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const file = parsed as Partial<TeamMetaFile>;
    if (file.version !== 1 || typeof file.cwd !== 'string') {
      return null;
    }

    if (
      options?.requireCompleteFields &&
      file.createdAt !== undefined &&
      (typeof file.createdAt !== 'number' || !Number.isFinite(file.createdAt))
    )
      return null;
    const providerId = normalizeProviderId(file.providerId);

    try {
      if (
        options?.skipScopeMigration &&
        ('specProject' in file || 'specSlug' in file || 'specBindings' in file)
      )
        throw new Error('Team specification scope requires migration before mutation');
      if (
        !options?.skipScopeMigration &&
        ('specProject' in file || 'specSlug' in file || 'specBindings' in file)
      ) {
        await withMetaMutationLock(
          metaPath,
          async () => {
            const current: unknown = JSON.parse(await readFileUtf8WithTimeout(metaPath, 5_000));
            if (
              !current ||
              typeof current !== 'object' ||
              Array.isArray(current) ||
              !('version' in current) ||
              current.version !== 1 ||
              !('cwd' in current) ||
              typeof current.cwd !== 'string'
            ) {
              throw new Error('Cannot migrate unreadable team metadata');
            }
            const migrated = migrateTeamSpecScope(current, teamName);
            await atomicWriteAsync(metaPath, serializeTeamMetadata(migrated));
          },
          false
        );
        return this.getMeta(teamName, teamsBasePath, options);
      }
      const normalized: TeamMetaFile = {
        version: 1,
        deletedAt: typeof file.deletedAt === 'string' ? file.deletedAt : undefined,
        runtimeSelectionVersion: normalizeRuntimeSelectionVersion(file.runtimeSelectionVersion),
        registryTeamId: normalizeOptionalString(file.registryTeamId) ?? undefined,
        registryRegistrationProject:
          normalizeOptionalString(file.registryRegistrationProject) ?? undefined,
        registryRegistrationRequestId:
          normalizeOptionalString(file.registryRegistrationRequestId) ?? undefined,
        registryRegistrationProtocol: file.registryRegistrationProtocol === 1 ? 1 : undefined,
        registryRegistrationIdentity: normalizeRegistrationIdentity(
          file.registryRegistrationIdentity
        ),
        registryRegistrationCompleted:
          typeof file.registryRegistrationCompleted === 'boolean'
            ? file.registryRegistrationCompleted
            : undefined,
        ...(file.specScope !== undefined
          ? { specScope: resolveTeamSpecScope(file, teamName) }
          : {}),
        displayName:
          typeof file.displayName === 'string' ? file.displayName.trim() || undefined : undefined,
        description:
          typeof file.description === 'string' ? file.description.trim() || undefined : undefined,
        color: typeof file.color === 'string' ? file.color.trim() || undefined : undefined,
        cwd: file.cwd.trim(),
        prompt: typeof file.prompt === 'string' ? file.prompt.trim() || undefined : undefined,
        providerId,
        providerBackendId: migrateProviderBackendId(
          providerId,
          normalizeOptionalBackendId(file.providerBackendId)
        ),
        model: typeof file.model === 'string' ? file.model.trim() || undefined : undefined,
        effort: typeof file.effort === 'string' ? file.effort.trim() || undefined : undefined,
        fastMode: normalizeFastMode(file.fastMode) ?? undefined,
        syncModelsWithLead:
          typeof file.syncModelsWithLead === 'boolean' ? file.syncModelsWithLead : undefined,
        skipPermissions:
          typeof file.skipPermissions === 'boolean' ? file.skipPermissions : undefined,
        worktree: typeof file.worktree === 'string' ? file.worktree.trim() || undefined : undefined,
        extraCliArgs:
          typeof file.extraCliArgs === 'string' ? file.extraCliArgs.trim() || undefined : undefined,
        limitContext: typeof file.limitContext === 'boolean' ? file.limitContext : undefined,
        launchIdentity: normalizeLaunchIdentity(file.launchIdentity),
        createdAt: typeof file.createdAt === 'number' ? file.createdAt : Date.now(),
      };
      return options?.requireCompleteFields && !hasCompleteKnownMetadata(file, normalized)
        ? null
        : normalized;
    } catch (error) {
      if (options?.requireCompleteFields) return null;
      throw error;
    }
  }

  async writeMeta(
    teamName: string,
    data: Omit<TeamMetaFile, 'version'>,
    teamsBasePath = getTeamsBasePath()
  ): Promise<void> {
    const metaPath = this.getMetaPath(teamName, teamsBasePath);
    await this.getMeta(teamName, teamsBasePath, { requireCompleteFields: true });
    await withMetaMutationLock(metaPath, async () => {
      const current = await this.getMeta(teamName, teamsBasePath, {
        requireCompleteFields: true,
        skipScopeMigration: true,
      });
      if (!current) {
        try {
          await fs.promises.lstat(metaPath);
          throw new Error('Cannot replace unreadable team metadata');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await this.writeMetaUnlocked(metaPath, {
        ...data,
        specScope: data.specScope ?? current?.specScope,
        registryTeamId: current?.registryTeamId ?? data.registryTeamId,
        registryRegistrationRequestId:
          current?.registryRegistrationRequestId ?? data.registryRegistrationRequestId,
        registryRegistrationProject:
          current?.registryRegistrationProject ?? data.registryRegistrationProject,
        registryRegistrationProtocol:
          current?.registryRegistrationProtocol ?? data.registryRegistrationProtocol,
        registryRegistrationIdentity:
          current?.registryRegistrationIdentity ?? data.registryRegistrationIdentity,
        registryRegistrationCompleted:
          current?.registryRegistrationCompleted ?? data.registryRegistrationCompleted,
        runtimeSelectionVersion:
          normalizeRuntimeSelectionVersion(data.runtimeSelectionVersion) ??
          current?.runtimeSelectionVersion,
      });
    });
  }
  /** Mutate canonical scope against the latest metadata under the existing writer lock. */
  async updateSpecScope(
    teamName: string,
    update: (current: TeamSpecScope) => TeamSpecScope,
    teamsBasePath = getTeamsBasePath()
  ): Promise<void> {
    await this.updateMeta(
      teamName,
      (current) => {
        if (!current || current.deletedAt) throw new Error('Team metadata is missing or deleted');
        const scope = resolveTeamSpecScope(current, teamName);
        return {
          ...current,
          specScope: resolveTeamSpecScope({ specScope: update(scope) }, teamName),
        };
      },
      teamsBasePath
    );
  }

  async updateMeta(
    teamName: string,
    update: (
      current: TeamMetaFile | null
    ) => Omit<TeamMetaFile, 'version'> | Promise<Omit<TeamMetaFile, 'version'>>,
    teamsBasePath = getTeamsBasePath()
  ): Promise<void> {
    const metaPath = this.getMetaPath(teamName, teamsBasePath);
    await this.getMeta(teamName, teamsBasePath, { requireCompleteFields: true });
    await withMetaMutationLock(metaPath, async () => {
      const current = await this.getMeta(teamName, teamsBasePath, {
        requireCompleteFields: true,
        skipScopeMigration: true,
      });
      if (!current) {
        try {
          await fs.promises.lstat(metaPath);
          throw new Error('Cannot update unreadable team metadata');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // The updater may mutate its argument in place, so retain the pre-update value.
      const previous = current ? structuredClone(current) : null;
      const data = await update(current);
      for (const field of [
        'registryRegistrationRequestId',
        'registryRegistrationProject',
        'registryTeamId',
      ] as const) {
        if (previous?.[field] && data[field] !== previous[field]) {
          throw new Error(`Cannot change durable ${field}`);
        }
      }
      if (
        previous?.registryRegistrationIdentity &&
        (!data.registryRegistrationIdentity ||
          !registrationIdentitiesEqual(
            data.registryRegistrationIdentity,
            previous.registryRegistrationIdentity
          ))
      ) {
        throw new Error('Cannot change durable registry registration identity');
      }
      if (
        previous?.registryRegistrationProtocol &&
        data.registryRegistrationProtocol !== previous.registryRegistrationProtocol
      ) {
        throw new Error('Cannot change durable registry registration protocol');
      }
      const serialized = this.serializeMeta(data);
      if (previous) {
        let previousSerialized: string | undefined;
        try {
          previousSerialized = this.serializeMeta(previous);
        } catch {
          // A prior value that cannot be serialized must not block a valid update.
        }
        if (serialized === previousSerialized) return;
      }
      await atomicWriteAsync(metaPath, serialized);
    });
  }

  /**
   * Reserve one stable registration request and project before any network call.
   * This does not authorize sending or retrying: the caller must first obtain
   * and fence the registry's authenticated principal and authoritative store.
   */
  async prepareRegistryRegistration(
    teamName: string,
    project: string,
    teamsBasePath = getTeamsBasePath()
  ): Promise<{ requestId: string; project: string; teamId?: string }> {
    const requestedProject = project.trim();
    if (!requestedProject || requestedProject !== project) {
      throw new Error('Registry registration requires an exact project');
    }
    const metaPath = this.getMetaPath(teamName, teamsBasePath);
    await this.getMeta(teamName, teamsBasePath, { requireCompleteFields: true });
    return withMetaMutationLock(
      metaPath,
      async () => {
        const current = await this.getMeta(teamName, teamsBasePath, {
          requireCompleteFields: true,
          skipScopeMigration: true,
        });
        if (!current) throw new Error('Team metadata is missing or unreadable');
        const requestId = current.registryRegistrationRequestId;
        if (requestId && current.registryRegistrationProtocol !== 1) {
          throw new Error('Legacy registration outcome is unknown; refusing unsafe replay');
        }
        if (requestId && current.registryRegistrationProject !== requestedProject) {
          throw new Error(
            'Registry registration project is missing or does not match the durable request'
          );
        }
        if (current.registryTeamId && !requestId) {
          throw new Error('Registered team is missing its durable registration request');
        }
        if (requestId) {
          return {
            requestId,
            project: requestedProject,
            ...(current.registryTeamId ? { teamId: current.registryTeamId } : {}),
          };
        }
        const nextRequestId = randomUUID();
        const { version: _version, ...data } = current;
        await this.writeMetaUnlocked(metaPath, {
          ...data,
          registryRegistrationRequestId: nextRequestId,
          registryRegistrationProject: requestedProject,
          registryRegistrationProtocol: 1,
          registryRegistrationCompleted: false,
        });
        return { requestId: nextRequestId, project: requestedProject };
      },
      false
    );
  }

  async fenceRegistryRegistration(
    teamName: string,
    project: string,
    requestId: string,
    identity: RegistryRegistrationIdentity,
    teamsBasePath = getTeamsBasePath()
  ): Promise<void> {
    const validIdentity = normalizeRegistrationIdentity(identity);
    if (!validIdentity) throw new Error('Invalid registry registration identity');
    await this.updateMeta(
      teamName,
      (current) => {
        if (
          !current ||
          current.registryRegistrationProtocol !== 1 ||
          current.registryRegistrationProject !== project ||
          current.registryRegistrationRequestId !== requestId
        ) {
          throw new Error('Registry registration reservation changed');
        }
        if (
          current.registryRegistrationIdentity &&
          !registrationIdentitiesEqual(current.registryRegistrationIdentity, validIdentity)
        ) {
          throw new Error('Registry registration identity mismatch');
        }
        const { version: _version, ...data } = current;
        return { ...data, registryRegistrationIdentity: validIdentity };
      },
      teamsBasePath
    );
  }

  async recordRegistryRegistration(
    teamName: string,
    project: string,
    requestId: string,
    identity: RegistryRegistrationIdentity,
    teamId: string,
    teamsBasePath = getTeamsBasePath()
  ): Promise<void> {
    if (!teamId || teamId !== teamId.trim()) throw new Error('Invalid registry team identity');
    await this.updateMeta(
      teamName,
      (current) => {
        if (
          !current ||
          current.registryRegistrationProtocol !== 1 ||
          current.registryRegistrationProject !== project ||
          current.registryRegistrationRequestId !== requestId ||
          !current.registryRegistrationIdentity ||
          !registrationIdentitiesEqual(current.registryRegistrationIdentity, identity) ||
          (current.registryTeamId && current.registryTeamId !== teamId)
        ) {
          throw new Error('Registry registration result does not match its durable fence');
        }
        const { version: _version, ...data } = current;
        return { ...data, registryTeamId: teamId };
      },
      teamsBasePath
    );
  }

  private async writeMetaUnlocked(
    metaPath: string,
    data: Omit<TeamMetaFile, 'version'>
  ): Promise<void> {
    await atomicWriteAsync(metaPath, this.serializeMeta(data));
  }

  serializeMeta(input: Omit<TeamMetaFile, 'version'>): string {
    const data = migrateTeamSpecScope(input);
    return serializeTeamMetadata({
      version: 1,
      deletedAt: data.deletedAt,
      runtimeSelectionVersion: normalizeRuntimeSelectionVersion(data.runtimeSelectionVersion),
      registryTeamId: normalizeOptionalString(data.registryTeamId) ?? undefined,
      registryRegistrationProject:
        normalizeOptionalString(data.registryRegistrationProject) ?? undefined,
      registryRegistrationRequestId:
        normalizeOptionalString(data.registryRegistrationRequestId) ?? undefined,
      registryRegistrationProtocol: data.registryRegistrationProtocol === 1 ? 1 : undefined,
      registryRegistrationIdentity: normalizeRegistrationIdentity(
        data.registryRegistrationIdentity
      ),
      registryRegistrationCompleted: data.registryRegistrationCompleted,
      ...(data.specScope !== undefined ? { specScope: resolveTeamSpecScope(data) } : {}),
      displayName: data.displayName?.trim() || undefined,
      description: data.description?.trim() || undefined,
      color: data.color?.trim() || undefined,
      cwd: data.cwd.trim(),
      prompt: data.prompt?.trim() || undefined,
      providerId: data.providerId,
      providerBackendId: migrateProviderBackendId(
        data.providerId,
        normalizeOptionalBackendId(data.providerBackendId)
      ),
      model: data.model?.trim() || undefined,
      effort: data.effort?.trim() || undefined,
      fastMode: normalizeFastMode(data.fastMode) ?? undefined,
      syncModelsWithLead: data.syncModelsWithLead,
      skipPermissions: data.skipPermissions,
      worktree: data.worktree?.trim() || undefined,
      extraCliArgs: data.extraCliArgs?.trim() || undefined,
      limitContext: data.limitContext,
      launchIdentity: normalizeLaunchIdentity(data.launchIdentity),
      createdAt: data.createdAt,
    } satisfies TeamMetaFile);
  }

  async deleteMeta(teamName: string): Promise<void> {
    const metaPath = this.getMetaPath(teamName);
    await withMetaMutationLock(metaPath, async () => {
      try {
        await fs.promises.unlink(metaPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }
}
