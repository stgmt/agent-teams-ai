import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { join } from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { TeamConfigReader } from './TeamConfigReader';
import { resolveTeamSpecBinding } from './registry/TeamSpecBinding';

import type { TeamMetaStore } from './TeamMetaStore';
import type { TeamConfig } from '@shared/types';

export interface TeamConfigurationMutationStores {
  configReader: TeamConfigReader;
  teamMetaStore: TeamMetaStore;
  invalidate(teamName: string): void;
}
/** Canonical manual and external writes share metadata preservation, without inventing saved requests. */
export async function updateTeamConfiguration(
  teamName: string,
  updates: {
    name?: string;
    description?: string;
    color?: string;
    specProject?: string;
    specSlug?: string;
  },
  stores: TeamConfigurationMutationStores
): Promise<TeamConfig | null> {
  const config = await stores.configReader.getConfig(teamName);
  const meta = await stores.teamMetaStore.getMeta(teamName);
  if (!config && !meta) throw new Error(`Team not found: ${teamName}`);
  if (config?.deletedAt || meta?.deletedAt)
    throw new Error('TEAM_TRASHED: Restore the team before editing');
  const currentBinding = config ?? meta;
  const nextBinding = resolveTeamSpecBinding({ ...currentBinding, ...updates }, teamName);
  if (
    currentBinding?.specProject?.trim() &&
    currentBinding.specSlug?.trim() &&
    (currentBinding.specProject.trim() !== nextBinding.project ||
      currentBinding.specSlug.trim() !== nextBinding.spec)
  ) {
    throw new Error(
      'SPEC_BINDING_IMMUTABLE: Create a separate team for a different specification; existing task history is tied to this team.'
    );
  }
  const applyMetadata = (current: NonNullable<typeof meta>) => ({
    ...current,
    ...(updates.name !== undefined ? { displayName: updates.name } : {}),
    ...(updates.description !== undefined ? { description: updates.description } : {}),
    ...(updates.color !== undefined ? { color: updates.color } : {}),
    ...(updates.specProject !== undefined ? { specProject: updates.specProject.trim() } : {}),
    ...(updates.specSlug !== undefined ? { specSlug: updates.specSlug.trim() } : {}),
  });
  // Validate the complete saved launch settings before the first config write.
  if (meta) stores.teamMetaStore.serializeMeta(applyMetadata(meta));
  const updated = config ? await stores.configReader.updateConfig(teamName, updates) : null;
  if (meta)
    await stores.teamMetaStore.updateMeta(teamName, (current) => {
      if (!current) throw new Error('Saved team configuration disappeared');
      return applyMetadata(current);
    });
  if (!config) TeamConfigReader.invalidateListTeamsCache();
  stores.invalidate(teamName);
  return updated;
}
export async function setTeamDeleted(
  teamName: string,
  deleted: boolean,
  stores: TeamConfigurationMutationStores
): Promise<void> {
  const config = await stores.configReader.getConfig(teamName);
  if (config) {
    if (Boolean(config.deletedAt) === deleted) return;
    const next = { ...config };
    if (deleted) next.deletedAt = new Date().toISOString();
    else delete next.deletedAt;
    await atomicWriteAsync(
      join(getTeamsBasePath(), teamName, 'config.json'),
      JSON.stringify(next, null, 2)
    );
    await TeamConfigReader.primeConfig(teamName, next);
  } else {
    await stores.teamMetaStore.updateMeta(teamName, (meta) => {
      if (!meta) throw new Error(`Team not found: ${teamName}`);
      return {
        ...meta,
        deletedAt: deleted ? (meta.deletedAt ?? new Date().toISOString()) : undefined,
      };
    });
    TeamConfigReader.invalidateListTeamsCache();
  }
  stores.invalidate(teamName);
}
