// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyClaudeOauthTokenIfMissing,
  readClaudeOauthCredential,
} from '../../../../src/main/services/runtime/claudeOauthToken';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 20 });
});

function claudeDir(credentials: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-oauth-'));
  directories.push(directory);
  if (credentials !== undefined)
    writeFileSync(
      join(directory, '.credentials.json'),
      typeof credentials === 'string' ? credentials : JSON.stringify(credentials)
    );
  return directory;
}

describe('claude subscription credential', () => {
  it('reads an unexpired access token', async () => {
    const dir = claudeDir({
      claudeAiOauth: { accessToken: 'token-1', expiresAt: Date.now() + 60_000 },
    });
    await expect(readClaudeOauthCredential(dir)).resolves.toMatchObject({
      accessToken: 'token-1',
    });
  });

  it('treats an expired token as absent', async () => {
    const dir = claudeDir({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 1 } });
    await expect(readClaudeOauthCredential(dir)).resolves.toBeNull();
  });

  it('answers null for a missing, malformed or tokenless file', async () => {
    await expect(readClaudeOauthCredential(claudeDir(undefined))).resolves.toBeNull();
    await expect(readClaudeOauthCredential(claudeDir('{not json'))).resolves.toBeNull();
    await expect(readClaudeOauthCredential(claudeDir({ claudeAiOauth: {} }))).resolves.toBeNull();
  });

  it('fills a member environment only when nothing else authenticates it', async () => {
    const dir = claudeDir({
      claudeAiOauth: { accessToken: 'token-2', expiresAt: Date.now() + 60_000 },
    });

    const empty: NodeJS.ProcessEnv = {};
    await expect(applyClaudeOauthTokenIfMissing(empty, dir)).resolves.toBe(true);
    expect(empty.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-2');

    const withKey: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'key' };
    await expect(applyClaudeOauthTokenIfMissing(withKey, dir)).resolves.toBe(false);
    expect(withKey.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
