// @vitest-environment node
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  steps?: WorkflowStep[];
}

interface ReleaseWorkflow {
  jobs?: Record<string, WorkflowJob>;
}

describe('Windows x64 packaging workflows', () => {
  it('builds and publishes only the native Windows x64 installer', async () => {
    const source = await readFile('.github/workflows/release.yml', 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const jobs = workflow.jobs ?? {};
    const runtimeVerificationTargets =
      jobs['verify-public-runtime']?.strategy?.matrix?.include;
    const releaseJob = jobs['release-win'];
    const targets = releaseJob?.strategy?.matrix?.include;

    expect(targets).toEqual([
      {
        arch: 'x64',
        runner: 'windows-2022',
        runtime_platform: 'win32-x64',
        bundle_directory: 'win-unpacked',
      },
    ]);
    expect(runtimeVerificationTargets).toEqual([
      {
        platform: 'win32-x64',
        runner: 'windows-2022',
      },
    ]);
    expect(jobs['release-mac']).toBeUndefined();
    expect(jobs['release-linux']).toBeUndefined();

    const commands = (releaseJob?.steps ?? []).map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('stage-runtime.mjs --platform ${{ matrix.runtime_platform }}');
    expect(commands).toContain(
      'stage-terminal-platform-runtime.mjs --platform ${{ matrix.runtime_platform }}'
    );
    expect(commands).not.toContain('stage-opencode-console-wrapper.mjs');
    expect(commands).not.toContain('resources/runtime/opencode-console/opencode.exe');
    expect(commands).toContain('pnpm pack:win:${{ matrix.arch }} --publish never');
    expect(commands).toContain(
      'verifyBundle.cjs "release/${{ matrix.bundle_directory }}" win32 ${{ matrix.arch }}'
    );
    expect(commands).not.toContain('pack:win:arm64');
    expect(commands).not.toContain('win-arm64-unpacked');
    const packagedSource = await readFile('.github/workflows/electron-packaged-ci.yml', 'utf8');
    const packagedWorkflow = parse(packagedSource) as ReleaseWorkflow;
    const packagedJob = packagedWorkflow.jobs?.['packaged-smoke'];
    expect(packagedJob?.strategy?.matrix?.include).toEqual([
      {
        platform: 'win32-x64',
        arch: 'x64',
        os: 'win32',
        runner: 'windows-2022',
        pack: 'pack:win:x64',
        bundle: 'release/win-unpacked',
      },
    ]);
    const packagedCommands = (packagedJob?.steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    expect(packagedCommands).not.toContain('stage-opencode-console-wrapper.mjs');
    expect(packagedCommands).not.toContain('resources/runtime/opencode-console/opencode.exe');
    expect(packagedCommands).not.toContain('pack:win:arm64');

    const runtimeStageIndex = commands.indexOf(
      'stage-runtime.mjs --platform ${{ matrix.runtime_platform }}'
    );
    const packageIndex = commands.indexOf('pnpm pack:win:${{ matrix.arch }} --publish never');
    expect(runtimeStageIndex).toBeGreaterThanOrEqual(0);
    expect(packageIndex).toBeGreaterThan(runtimeStageIndex);
  });
});
