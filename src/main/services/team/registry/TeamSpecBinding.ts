/** Canonical registry scope; legacy formats are accepted only by the migration boundary. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { assertSafeTeamName } from '../permanent-deletion/TeamPermanentDeletionTypes';
import { isReadableTeamConfigPayload } from '../TeamConfigPayload';

import type { TeamSpecBinding, TeamSpecScope } from '@shared/types';
export type { TeamSpecBinding, TeamSpecScope } from '@shared/types';

export interface TeamSpecBindingConfig {
  specScope?: unknown;
  registryTeamId?: unknown;
  registryRegistrationRequestId?: unknown;
  registryRegistrationCompleted?: unknown;
}

export type TeamSpecBindingErrorCode =
  | 'SPEC_PROJECT_MISSING'
  | 'SPEC_PROJECT_INVALID'
  | 'SPEC_SLUG_MISSING'
  | 'SPEC_SLUG_INVALID'
  | 'SPEC_BINDINGS_INVALID'
  | 'SPEC_BINDING_DUPLICATE';

export class TeamSpecBindingError extends Error {
  readonly name = 'TeamSpecBindingError';
  constructor(
    readonly code: TeamSpecBindingErrorCode,
    readonly teamName: string,
    message: string
  ) {
    super(message);
  }
}

const PROJECT_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SPEC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSpecProject(value: unknown, teamName = ''): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_MISSING',
      teamName,
      'A registry project is required'
    );
  }
  const project = value.trim();
  const segments = project.split('/');
  if (
    segments.length !== 2 ||
    !segments.every((segment) => PROJECT_SEGMENT_PATTERN.test(segment))
  ) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_INVALID',
      teamName,
      'Invalid registry project; expected <owner>/<project>'
    );
  }
  return project;
}

export function validateSpecBinding(value: unknown, teamName = ''): TeamSpecBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('project' in value) ||
    !('spec' in value)
  ) {
    throw new TeamSpecBindingError(
      'SPEC_BINDINGS_INVALID',
      teamName,
      'A binding requires project and spec'
    );
  }
  const project = validateSpecProject(value.project, teamName);
  if (typeof value.spec !== 'string' || !value.spec.trim()) {
    throw new TeamSpecBindingError(
      'SPEC_SLUG_MISSING',
      teamName,
      'A specification slug is required'
    );
  }
  const spec = value.spec.trim();
  if (spec.length > 120 || !SPEC_SLUG_PATTERN.test(spec)) {
    throw new TeamSpecBindingError('SPEC_SLUG_INVALID', teamName, 'Invalid specification slug');
  }
  return { project, spec };
}

export function resolveTeamSpecScope(
  config: TeamSpecBindingConfig | null | undefined,
  teamName = ''
): TeamSpecScope {
  const scope = config?.specScope;
  if (
    !scope ||
    typeof scope !== 'object' ||
    Array.isArray(scope) ||
    !('projects' in scope) ||
    !('bindings' in scope) ||
    !Array.isArray(scope.projects) ||
    !Array.isArray(scope.bindings)
  ) {
    throw new TeamSpecBindingError(
      'SPEC_BINDINGS_INVALID',
      teamName,
      'A canonical specification scope is required'
    );
  }
  const projects = scope.projects.map((project) => validateSpecProject(project, teamName));
  if (!projects.length || new Set(projects).size !== projects.length) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_INVALID',
      teamName,
      'Specification scope requires distinct permitted projects'
    );
  }
  const bindings = scope.bindings.map((binding) => validateSpecBinding(binding, teamName));
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!projects.includes(binding.project)) {
      throw new TeamSpecBindingError(
        'SPEC_PROJECT_INVALID',
        teamName,
        'Specification binding is outside the permitted projects'
      );
    }
    const key = `${binding.project}\u0000${binding.spec}`;
    if (seen.has(key))
      throw new TeamSpecBindingError(
        'SPEC_BINDING_DUPLICATE',
        teamName,
        'Duplicate specification binding'
      );
    seen.add(key);
  }
  return { projects, bindings };
}

export function resolveTeamSpecBindings(
  config: TeamSpecBindingConfig | null | undefined,
  teamName = ''
): TeamSpecBinding[] {
  return config?.specScope === undefined ? [] : resolveTeamSpecScope(config, teamName).bindings;
}

export function resolveTeamSpecBinding(
  config: TeamSpecBindingConfig | null | undefined,
  teamName = ''
): TeamSpecBinding {
  const bindings = resolveTeamSpecBindings(config, teamName);
  if (bindings.length !== 1)
    throw new TeamSpecBindingError(
      'SPEC_BINDINGS_INVALID',
      teamName,
      'Exactly one specification binding is required'
    );
  return bindings[0];
}

export function bindingFromTeamMetadata(
  config: TeamSpecBindingConfig,
  meta: TeamSpecBindingConfig | null | undefined
): TeamSpecBindingConfig {
  if ('specProject' in config || 'specSlug' in config || 'specBindings' in config) {
    throw new TeamSpecBindingError(
      'SPEC_BINDINGS_INVALID',
      '',
      'Legacy runtime scope must be migrated before use'
    );
  }
  if (!meta?.specScope) {
    if (config.specScope !== undefined)
      throw new TeamSpecBindingError(
        'SPEC_BINDINGS_INVALID',
        '',
        'Canonical metadata scope is required for the runtime projection'
      );
    return {};
  }
  const scope = resolveTeamSpecScope(meta);
  if (config.specScope !== undefined) {
    const projection = resolveTeamSpecScope(config);
    if (
      projection.projects.length !== scope.projects.length ||
      projection.projects.some((project) => !scope.projects.includes(project)) ||
      projection.bindings.length !== scope.bindings.length ||
      projection.bindings.some(
        (binding) =>
          !scope.bindings.some(
            (entry) => entry.project === binding.project && entry.spec === binding.spec
          )
      )
    ) {
      throw new TeamSpecBindingError(
        'SPEC_BINDINGS_INVALID',
        '',
        'Runtime scope conflicts with canonical metadata'
      );
    }
  }
  return {
    specScope: scope,
    registryTeamId: meta.registryTeamId,
    registryRegistrationRequestId: meta.registryRegistrationRequestId,
    registryRegistrationCompleted: meta.registryRegistrationCompleted,
  };
}

export async function resolveRegistryBindingConfig(
  teamName: string,
  sources: {
    readConfig: (teamName: string) => Promise<unknown>;
    readMetadata: (teamName: string) => Promise<TeamSpecBindingConfig | null | undefined>;
  }
): Promise<TeamSpecBindingConfig | null> {
  assertSafeTeamName(teamName);
  const config = await sources.readConfig(teamName);
  if (config !== null && config !== undefined) {
    if (typeof config !== 'object' || Array.isArray(config) || !isReadableTeamConfigPayload(config))
      return null;
    if ('specProject' in config || 'specSlug' in config || 'specBindings' in config) {
      throw new TeamSpecBindingError(
        'SPEC_BINDINGS_INVALID',
        teamName,
        'Legacy runtime scope must be migrated before use'
      );
    }
    return bindingFromTeamMetadata(
      {
        specScope: 'specScope' in config ? config.specScope : undefined,
        registryTeamId: 'registryTeamId' in config ? config.registryTeamId : undefined,
        registryRegistrationRequestId:
          'registryRegistrationRequestId' in config
            ? config.registryRegistrationRequestId
            : undefined,
        registryRegistrationCompleted:
          'registryRegistrationCompleted' in config
            ? config.registryRegistrationCompleted
            : undefined,
      },
      await sources.readMetadata(teamName)
    );
  }
  try {
    await fs.promises.lstat(path.join(getTeamsBasePath(), teamName, 'config.json'));
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return bindingFromTeamMetadata({}, await sources.readMetadata(teamName));
}
