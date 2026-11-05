import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The OAuth token Claude Code already holds for a subscription.
 *
 * A teammate is a separate process: it does not inherit the desktop's session, and the
 * orchestrator refuses to start a turn without `ANTHROPIC_API_KEY` or
 * `CLAUDE_CODE_OAUTH_TOKEN` in its environment. On a machine where the user signed in to
 * Claude Code, the token is already on disk — reading it is what lets a team start
 * without asking the user to sign in twice.
 *
 * The token value is never returned to logs: only the caller that builds a child
 * environment sees it.
 */
export interface ClaudeOauthCredential {
  accessToken: string;
  expiresAt: number | null;
}

export async function readClaudeOauthCredential(
  claudeBasePath: string,
  now: number = Date.now()
): Promise<ClaudeOauthCredential | null> {
  let raw: string;
  try {
    raw = await readFile(join(claudeBasePath, '.credentials.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (!oauth) return null;
  const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
  if (!accessToken) return null;
  const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;
  // A token that is already expired would turn a clear "sign in" into a confusing
  // auth error from the runtime, so it is treated as absent.
  if (expiresAt !== null && expiresAt <= now) return null;
  return { accessToken, expiresAt };
}

/**
 * Puts the subscription token into a member environment when nothing else would
 * authenticate it. An explicit API key or token always wins.
 */
export async function applyClaudeOauthTokenIfMissing(
  env: NodeJS.ProcessEnv,
  claudeBasePath: string,
  now: number = Date.now()
): Promise<boolean> {
  if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return false;
  const credential = await readClaudeOauthCredential(claudeBasePath, now);
  if (!credential) return false;
  env.CLAUDE_CODE_OAUTH_TOKEN = credential.accessToken;
  return true;
}
