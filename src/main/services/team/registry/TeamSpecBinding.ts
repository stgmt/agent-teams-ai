/** Every team's canonical tasks belong to an explicitly bound registry spec. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { assertSafeTeamName } from '../permanent-deletion/TeamPermanentDeletionTypes';
import { isReadableTeamConfigPayload } from '../TeamConfigPayload';

import type { TeamSpecBinding } from '@shared/types';

export type { TeamSpecBinding } from '@shared/types';

/** Untrusted persisted team binding and registry identity; resolver validates runtime values. */
export interface TeamSpecBindingConfig {
  specBindings?: unknown;
  specProject?: unknown;
  specSlug?: unknown;
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

/**
 * A team declared a spec binding the app cannot honour. This is raised instead
 * of silently falling back to the file store, so a half-configured team cannot
 * fork its task state into two sources.
 */
export class TeamSpecBindingError extends Error {
  readonly code: TeamSpecBindingErrorCode;
  readonly teamName: string;

  constructor(code: TeamSpecBindingErrorCode, teamName: string, message: string) {
    super(message);
    this.name = 'TeamSpecBindingError';
    this.code = code;
    this.teamName = teamName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const PROJECT_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SPEC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A draft's binding is saved in team metadata before a runtime creates config.json.
 * An explicit (even incomplete) config binding always wins so a broken config
 * cannot silently select a different specification.
 */
function registryIdentityFrom(
  config: TeamSpecBindingConfig,
  meta: TeamSpecBindingConfig | null | undefined
): Pick<
  TeamSpecBindingConfig,
  'registryTeamId' | 'registryRegistrationRequestId' | 'registryRegistrationCompleted'
> {
  return {
    registryTeamId:
      readTrimmed(meta?.registryTeamId) ?? readTrimmed(config.registryTeamId) ?? undefined,
    registryRegistrationRequestId:
      readTrimmed(meta?.registryRegistrationRequestId) ??
      readTrimmed(config.registryRegistrationRequestId) ??
      undefined,
    registryRegistrationCompleted:
      typeof meta?.registryRegistrationCompleted === 'boolean'
        ? meta.registryRegistrationCompleted
        : typeof config.registryRegistrationCompleted === 'boolean'
          ? config.registryRegistrationCompleted
          : undefined,
  };
}

function bindingFieldsFrom(
  source: TeamSpecBindingConfig | null | undefined
): Pick<TeamSpecBindingConfig, 'specBindings' | 'specProject' | 'specSlug'> {
  if (source?.specBindings !== undefined) return { specBindings: source.specBindings };
  if (source?.specProject !== undefined || source?.specSlug !== undefined) {
    return { specProject: source.specProject, specSlug: source.specSlug };
  }
  return {};
}

export function bindingFromTeamMetadata(
  config: TeamSpecBindingConfig,
  meta: TeamSpecBindingConfig | null | undefined
): TeamSpecBindingConfig {
  const identity = registryIdentityFrom(config, meta);
  const configBinding = bindingFieldsFrom(config);
  if (Object.keys(configBinding).length > 0) return { ...configBinding, ...identity };
  return { ...bindingFieldsFrom(meta), ...identity };
}

/**
 * Resolves registry scope from a validated config snapshot. Some runtimes write
 * a valid config without either binding field; those drafts recover both fields
 * from metadata. An explicit field, including an incomplete binding, takes
 * precedence. A null snapshot may use metadata only after config.json is
 * confirmed absent; broken or unreadable config never falls back.
 */
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
    if (
      typeof config !== 'object' ||
      Array.isArray(config) ||
      !isReadableTeamConfigPayload(config)
    ) {
      return null;
    }
    const configBinding: TeamSpecBindingConfig = {
      specBindings: 'specBindings' in config ? config.specBindings : undefined,
      specProject: 'specProject' in config ? config.specProject : undefined,
      specSlug: 'specSlug' in config ? config.specSlug : undefined,
      registryTeamId: 'registryTeamId' in config ? config.registryTeamId : undefined,
      registryRegistrationRequestId:
        'registryRegistrationRequestId' in config
          ? config.registryRegistrationRequestId
          : undefined,
      registryRegistrationCompleted:
        'registryRegistrationCompleted' in config
          ? config.registryRegistrationCompleted
          : undefined,
    };
    return bindingFromTeamMetadata(configBinding, await sources.readMetadata(teamName));
  }

  const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
  try {
    await fs.promises.lstat(configPath);
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return bindingFromTeamMetadata({}, await sources.readMetadata(teamName));
}

/** Resolves the required registry binding, failing explicitly when incomplete. */
export function resolveTeamSpecBinding(
  config: TeamSpecBindingConfig | null | undefined,
  teamName = ''
): TeamSpecBinding {
  const project = readTrimmed(config?.specProject);
  const spec = readTrimmed(config?.specSlug);
  if (!project) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_MISSING',
      teamName,
      `Team ${teamName || '<unknown>'} requires specProject and specSlug to address canonical tasks`
    );
  }
  const projectSegments = project.split('/');
  const projectValid =
    projectSegments.length === 2 &&
    projectSegments.every((segment) => PROJECT_SEGMENT_PATTERN.test(segment));
  if (!projectValid) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_INVALID',
      teamName,
      `Team ${teamName || '<unknown>'} has an invalid specProject "${project}"; expected "<owner>/<project>"`
    );
  }
  if (!spec) {
    throw new TeamSpecBindingError(
      'SPEC_SLUG_MISSING',
      teamName,
      `Team ${teamName || '<unknown>'} sets specProject "${project}" without specSlug; the registry cannot be addressed`
    );
  }
  if (spec.length > 120 || !SPEC_SLUG_PATTERN.test(spec)) {
    throw new TeamSpecBindingError(
      'SPEC_SLUG_INVALID',
      teamName,
      `Team ${teamName || '<unknown>'} has an invalid specSlug "${spec}"`
    );
  }
  return { project, spec };
}

/** Resolve every configured binding; legacy single-spec pairs remain supported. */
export function resolveTeamSpecBindings(
  config: TeamSpecBindingConfig | null | undefined,
  teamName = ''
): TeamSpecBinding[] {
  if (config?.specBindings !== undefined) {
    if (!Array.isArray(config.specBindings)) {
      throw new TeamSpecBindingError(
        'SPEC_BINDINGS_INVALID',
        teamName,
        `Team ${teamName || '<unknown>'} has invalid specBindings; expected an array`
      );
    }
    const bindings = config.specBindings.map((value): TeamSpecBinding => {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('project' in value) ||
        !('spec' in value) ||
        typeof value.project !== 'string' ||
        typeof value.spec !== 'string'
      ) {
        throw new TeamSpecBindingError(
          'SPEC_BINDINGS_INVALID',
          teamName,
          `Team ${teamName || '<unknown>'} has a spec binding without project and spec`
        );
      }
      return resolveTeamSpecBinding({ specProject: value.project, specSlug: value.spec }, teamName);
    });
    const seen = new Set<string>();
    for (const binding of bindings) {
      const key = `${binding.project}\u0000${binding.spec}`;
      if (seen.has(key)) {
        throw new TeamSpecBindingError(
          'SPEC_BINDING_DUPLICATE',
          teamName,
          `Team ${teamName || '<unknown>'} has duplicate spec binding "${binding.project}/${binding.spec}"`
        );
      }
      seen.add(key);
    }
    return bindings;
  }
  if (config?.specProject !== undefined || config?.specSlug !== undefined) {
    return [resolveTeamSpecBinding(config, teamName)];
  }
  return [];
}
