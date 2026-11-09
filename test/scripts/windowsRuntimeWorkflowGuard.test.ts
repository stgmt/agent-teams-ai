// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep { name?: string; run?: string }
interface Workflow { jobs: { 'prepare-runtime': { steps: WorkflowStep[] } } }

function checkAssets(kind: string, existing: string, valid = true) {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow;
  const step = workflow.jobs['prepare-runtime'].steps.find((item) => item.name === 'Check runtime assets');
  if (!step?.run) throw new Error('Runtime asset check is missing');
  const root = mkdtempSync(path.join(tmpdir(), 'runtime-workflow-'));
  const output = path.join(root, 'github-output');
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const stubs = `
node() {
  case "$1" in
    ./scripts/ci/verify-runtime-lock.mjs) [ "$VALID_LOCK" = 1 ] ;;
    -p) printf '%s\\n' "$RELEASE_KIND_FIXTURE" ;;
    ./scripts/runtime-lock.mjs)
      case "$2" in
        source-repository) echo stgmt/agent_teams_orchestrator ;;
        release-repository) echo stgmt/agent_teams_orchestrator ;;
        release-tag) echo fixture-tag ;;
        asset-list) echo required-runtime.zip ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
}
gh() { printf '%s\\n' "$EXISTING_ASSETS"; }
`;
  try {
    const result = spawnSync(shell, ['-c', `${stubs}\n${step.run}`], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, VALID_LOCK: valid ? '1' : '0', RELEASE_KIND_FIXTURE: kind, EXISTING_ASSETS: existing, GITHUB_OUTPUT: output },
    });
    let outputs = '';
    try { outputs = readFileSync(output, 'utf8'); } catch { /* Failed checks produce no output file. */ }
    return { status: result.status, stderr: result.stderr, outputs };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

describe('release runtime asset gate', () => {
  it('refuses a missing Windows-only asset instead of dispatching an upstream runtime build', () => {
    const result = checkAssets('windows-x64-claude-only', '');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to continue');
    expect(result.outputs).toBe('');
  });

  it('allows only the pinned Windows asset when it exists', () => {
    const result = checkAssets('windows-x64-claude-only', 'required-runtime.zip');
    expect(result.status).toBe(0);
    expect(result.outputs).toBe('');
  });

  it('fails closed for an upstream runtime lock instead of preserving the upstream build path', () => {
    const result = checkAssets('upstream', '', false);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });

  it('fails closed on an invalid runtime lock', () => {
    const result = checkAssets('windows-x64-claude-only', 'required-runtime.zip', false);
    expect(result.status).not.toBe(0);
    expect(result.outputs).toBe('');
  });
});
