import {
  resolveTeamSpecScope,
  TeamSpecBindingError,
  validateSpecBinding,
  validateSpecProject,
} from './TeamSpecBinding';

import type { TeamSpecBinding, TeamSpecScope } from '@shared/types';

/** One boundary for old persisted formats and UI input; runtime readers consume only specScope. */
export function migrateTeamSpecScope<T extends object>(
  source: T,
  teamName = ''
): Omit<T, 'specProject' | 'specSlug' | 'specBindings' | 'specScope'> & {
  specScope?: TeamSpecScope;
} {
  const record = source as Record<string, unknown>;
  const { specProject, specSlug, specBindings, specScope, ...rest } = record;
  const projects: string[] = [];
  const bindings: TeamSpecBinding[] = [];
  const addProject = (project: string): void => {
    if (!projects.includes(project)) projects.push(project);
  };
  if (specBindings !== undefined) {
    if (!Array.isArray(specBindings))
      throw new TeamSpecBindingError(
        'SPEC_BINDINGS_INVALID',
        teamName,
        'Legacy specBindings must be an array'
      );
    for (const value of specBindings) {
      const binding = validateSpecBinding(value, teamName);
      addProject(binding.project);
      bindings.push(binding);
    }
  }
  if (specProject !== undefined || specSlug !== undefined) {
    const project = validateSpecProject(specProject, teamName);
    addProject(project);
    if (specSlug !== undefined) {
      const binding = validateSpecBinding({ project, spec: specSlug }, teamName);
      if (
        specBindings !== undefined &&
        !bindings.some((entry) => entry.project === project && entry.spec === binding.spec)
      ) {
        throw new TeamSpecBindingError(
          'SPEC_BINDINGS_INVALID',
          teamName,
          'Conflicting legacy specification bindings'
        );
      }
      if (specBindings === undefined) bindings.push(binding);
    }
  }
  const legacy = projects.length
    ? resolveTeamSpecScope({ specScope: { projects, bindings } }, teamName)
    : undefined;
  const canonical =
    specScope === undefined ? legacy : resolveTeamSpecScope({ specScope }, teamName);
  if (
    specScope !== undefined &&
    legacy &&
    (legacy.projects.some((project) => !canonical!.projects.includes(project)) ||
      legacy.bindings.some(
        (binding) =>
          !canonical!.bindings.some(
            (entry) => entry.project === binding.project && entry.spec === binding.spec
          )
      ))
  ) {
    throw new TeamSpecBindingError(
      'SPEC_BINDINGS_INVALID',
      teamName,
      'Legacy specification data conflicts with canonical scope'
    );
  }
  return { ...rest, ...(canonical ? { specScope: canonical } : {}) } as Omit<
    T,
    'specProject' | 'specSlug' | 'specBindings' | 'specScope'
  > & { specScope?: TeamSpecScope };
}
