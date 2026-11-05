/**
 * Which teams are registry-backed.
 *
 * A team opts in through its own config (`specProject` + `specSlug`). There is
 * no global switch and no implied default: a team without the pair keeps the
 * legacy file behaviour byte-for-byte.
 */

import type { TeamConfig } from '@shared/types';

/** Registry scope one team's tasks belong to. */
export interface TeamSpecBinding {
  /** Registry project id, e.g. `stgmt/tokenplan`. */
  project: string;
  /** Spec slug inside the project, e.g. `balancer-consistency-hardening`. */
  spec: string;
}

export type TeamSpecBindingErrorCode = 'SPEC_PROJECT_INVALID' | 'SPEC_SLUG_MISSING';

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

const SPEC_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolves the team's registry binding.
 *
 * - no `specProject` and no `specSlug` → `null` (legacy file behaviour);
 * - `specSlug` without `specProject` → `null` as well: the slug alone does not
 *   say which project it lives in, so it cannot activate the flag;
 * - `specProject` without `specSlug` → typed error (the registry cannot be
 *   addressed without a spec);
 * - malformed ids → typed error.
 */
export function resolveTeamSpecBinding(
  config: Pick<TeamConfig, 'specProject' | 'specSlug'> | null | undefined,
  teamName = ''
): TeamSpecBinding | null {
  const project = readTrimmed(config?.specProject);
  const spec = readTrimmed(config?.specSlug);
  if (!project) {
    return null;
  }
  const projectSegments = project.split('/');
  const projectValid = projectSegments.every(
    (segment) => SPEC_SEGMENT_PATTERN.test(segment) && !segment.includes('..')
  );
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
  if (!SPEC_SEGMENT_PATTERN.test(spec) || spec.includes('..')) {
    throw new TeamSpecBindingError(
      'SPEC_PROJECT_INVALID',
      teamName,
      `Team ${teamName || '<unknown>'} has an invalid specSlug "${spec}"`
    );
  }
  return { project, spec };
}
