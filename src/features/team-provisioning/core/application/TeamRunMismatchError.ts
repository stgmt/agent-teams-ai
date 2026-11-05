export class TeamRunMismatchError extends Error {
  readonly code = 'TEAM_RUN_MISMATCH';

  constructor() {
    super('The application or team run identity is stale');
  }
}
