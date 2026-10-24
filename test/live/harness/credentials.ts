import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A token refresh made by the runtime in the sandbox copy could invalidate the refresh token
// of the main login. The copy is therefore taken only while the access token has this much
// life left: a live run takes 3-10 minutes (the startup run with nine members and the stall run
// stay under 12), so with 25 minutes in hand the runtime never reaches a refresh.
const MIN_REMAINING_MS = 25 * 60 * 1000;

export interface CopiedCredentials {
  remainingHours: number;
}

/**
 * Copies the owner login into the sandbox claude root. Only the numeric `expiresAt` is read
 * for the check; no token value is ever printed or put into an error message.
 */
export function copyCredentialsInto(claudeRoot: string): CopiedCredentials {
  const source = path.join(os.homedir(), '.claude', '.credentials.json');
  const raw = fs.readFileSync(source, 'utf8');
  const expiresAt = Number((JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: unknown } })
    .claudeAiOauth?.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new Error(`${source} has no numeric claudeAiOauth.expiresAt; the login cannot be copied`);
  }
  const remainingMs = expiresAt - Date.now();
  if (remainingMs < MIN_REMAINING_MS) {
    throw new Error(
      `The login in ${source} has ${(remainingMs / 3_600_000).toFixed(2)} h left, less than ` +
        `${(MIN_REMAINING_MS / 3_600_000).toFixed(2)} h. Not copied: a refresh inside the copy could log the ` +
        'main app out. Use the main app or the claude CLI once to renew the login, then rerun.'
    );
  }
  fs.writeFileSync(path.join(claudeRoot, '.credentials.json'), raw, { mode: 0o600 });
  return { remainingHours: remainingMs / 3_600_000 };
}
