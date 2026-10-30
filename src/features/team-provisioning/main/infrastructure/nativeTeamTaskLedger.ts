import { isAbsolute, join } from 'node:path';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

/** Application-owned project directory passed explicitly to the native runtime's task ledger. */
export function nativeTeamTaskLedgerProjectDirectory(teamsRoot: string, teamName: string): string {
  if (!isAbsolute(teamsRoot)) throw new Error('Native task ledger teams root must be absolute');
  const name = validateTeamName(teamName);
  if (!name.valid || name.value !== teamName) throw new Error('Invalid native task ledger team');
  return join(teamsRoot, teamName, 'task-ledger-project');
}
