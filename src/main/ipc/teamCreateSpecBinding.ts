import { migrateTeamSpecScope } from '../services/team/registry/TeamSpecBindingMigration';

import type { TeamSpecScope } from '@shared/types';

/** Boundary inputs normalize once; persisted and runtime callers use only specScope. */
export interface CreateTeamSpecBinding {
  specScope?: TeamSpecScope;
}

export type CreateTeamSpecBindingResult =
  | { ok: true; value: CreateTeamSpecBinding }
  | { ok: false; error: string };

export function resolveCreateTeamSpecBinding(payload: {
  specProject?: unknown;
  specSlug?: unknown;
  specScope?: unknown;
}): CreateTeamSpecBindingResult {
  const project = payload.specProject;
  if (project !== undefined && (typeof project !== 'string' || !project.trim())) {
    return { ok: false, error: 'specProject must be a non-empty string' };
  }
  const slug = payload.specSlug;
  if (slug !== undefined && (typeof slug !== 'string' || !slug.trim())) {
    return { ok: false, error: 'specSlug must be a non-empty string' };
  }
  const specProject = typeof project === 'string' ? project.trim() || undefined : undefined;
  const specSlug = typeof slug === 'string' ? slug.trim() || undefined : undefined;
  if (specProject === undefined && specSlug !== undefined) {
    return { ok: false, error: 'specSlug requires specProject' };
  }
  try {
    const migrated = migrateTeamSpecScope({
      ...(specProject ? { specProject } : {}),
      ...(specSlug ? { specSlug } : {}),
      ...(payload.specScope !== undefined ? { specScope: payload.specScope } : {}),
    });
    return { ok: true, value: migrated };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid specification scope',
    };
  }
}
