import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

import type { AppUpdater as AppUpdaterBase } from 'electron-updater/out/AppUpdater';
import type { ElectronHttpExecutor as ElectronHttpExecutorType } from 'electron-updater/out/electronHttpExecutor';
import type { GenericProvider as GenericProviderType } from 'electron-updater/out/providers/GenericProvider';
import type { parseUpdateInfo as ParseUpdateInfo } from 'electron-updater/out/providers/Provider';

import {
  buildUpdaterFeeds,
  getPromotionLayout,
  parsePromotionConfig,
} from '../../scripts/ci/promote-existing-draft.mjs';

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const { AppUpdater }: { AppUpdater: typeof AppUpdaterBase } = require('electron-updater/out/AppUpdater');
const { GenericProvider }: { GenericProvider: typeof GenericProviderType } = require(
  'electron-updater/out/providers/GenericProvider'
);
const { ElectronHttpExecutor }: { ElectronHttpExecutor: typeof ElectronHttpExecutorType } = require(
  'electron-updater/out/electronHttpExecutor'
);
const { parseUpdateInfo }: { parseUpdateInfo: typeof ParseUpdateInfo } = require(
  'electron-updater/out/providers/Provider'
);

// Exercise the real updater's metadata and eligibility pipeline without an
// Electron process, network server, or artifact download.
class FeedCompatibilityUpdater extends AppUpdater {
  constructor(
    private readonly feed: string,
    directory: string
  ) {
    super(undefined, {
      version: '2.15.0',
      name: 'release-compatibility-test',
      isPackaged: true,
      appUpdateConfigPath: path.join(directory, 'app-update.yml'),
      userDataPath: directory,
      baseCachePath: directory,
      whenReady: () => Promise.resolve(),
      relaunch: () => undefined,
      quit: () => undefined,
      onQuit: () => undefined,
    });
    this.autoDownload = false;
    this.logger = null;
  }

  protected override getUpdateInfoAndProvider() {
    const url = new URL('https://release-compatibility.invalid/');
    return Promise.resolve({
      info: parseUpdateInfo(this.feed, 'latest.yml', url),
      provider: new GenericProvider({ provider: 'generic', url: url.href }, this, {
        platform: 'win32',
        isUseMultipleRangeRequest: false,
        executor: new ElectronHttpExecutor(() => undefined),
      }),
    });
  }

  protected override doDownloadUpdate(): Promise<string[]> {
    return Promise.reject(new Error('Compatibility test must never download an update'));
  }

  override quitAndInstall(): void {
    throw new Error('Compatibility test must never install an update');
  }
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

type PromotionFixtureResult = {
  result: { status: number | null; stdout: string; stderr: string };
  state: {
    id: number;
    tag_name: string;
    draft: boolean;
    latestTag: string | null;
    assets: Array<{ id: number; name: string; size: number; digest: string }>;
  };
  calls: string[][];
  outputDirectory: string;
  tag: string;
};

async function runFakePromotion(
  overrides: Record<string, string> = {}
): Promise<PromotionFixtureResult> {
  const root = await makeTemporaryDirectory('promote-e2e-');
  const fixtures = path.join(root, 'fixtures');
  const outputDirectory = path.join(root, 'output');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(fixtures), mkdir(outputDirectory), mkdir(bin)]);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));

  const version = '9.9.9';
  const tag = `v${version}`;
  const targetCommit = 'a'.repeat(40);
  const layout = getPromotionLayout(version);
  const sourceName = layout.sourceAssets[0];
  const blockmapName = `${sourceName}.blockmap`;
  const sourceBytes = Buffer.from(`fixture:${sourceName}`);
  const blockmapBytes = Buffer.from(`fixture:${blockmapName}`);
  await writeFile(path.join(fixtures, sourceName), sourceBytes);
  const statePath = path.join(root, 'release-state.json');
  await writeFile(
    statePath,
    JSON.stringify({
      id: 123,
      tag_name: tag,
      target_commitish: targetCommit,
      name: tag,
      body: 'Release notes',
      draft: true,
      latestTag: null,
      nextAssetId: 3,
      assets: [
        {
          id: 1,
          name: sourceName,
          digest: `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`,
          size: sourceBytes.length,
        },
        {
          id: 2,
          name: blockmapName,
          digest: `sha256:${createHash('sha256').update(blockmapBytes).digest('hex')}`,
          size: blockmapBytes.length,
        },
      ],
    })
  );

  const fetchHookPath = path.join(root, 'fetch-hook.cjs');
  await writeFile(
    fetchHookPath,
    `const fs = require('node:fs');
global.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const state = JSON.parse(fs.readFileSync(process.env.FAKE_RELEASE_STATE, 'utf8'));
  const json = value => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  if (url.hostname === 'api.github.com' && url.pathname.endsWith('/releases/latest')) {
    if (!state.latestTag) return new Response(null, { status: 404 });
    return json({
      id: state.id,
      tag_name: state.latestTag,
      draft: false,
      prerelease: false,
    });
  }
  if (url.hostname === 'api.github.com' && url.pathname.includes('/releases/tags/')) {
    return json({
      id: state.id,
      tag_name: state.tag_name,
      draft: state.draft,
      prerelease: false,
    });
  }
  if (url.hostname === 'github.com' && url.pathname.includes('/releases/')) {
    if (url.pathname.includes('/releases/latest/download/') && !state.latestTag) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 404 });
};
`
  );

  const fakeGhPath = path.join(bin, 'gh');
  await writeFile(
    fakeGhPath,
    `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const readState = () => JSON.parse(fs.readFileSync(process.env.FAKE_RELEASE_STATE, 'utf8'));
const writeState = state => fs.writeFileSync(process.env.FAKE_RELEASE_STATE, JSON.stringify(state));
const apiRelease = state => ({
  id: state.id,
  tag_name: state.tag_name,
  target_commitish: state.target_commitish,
  draft: state.draft,
  assets: state.assets,
});
if (args[0] === 'release' && args[1] === 'view') {
  const state = readState();
  process.stdout.write(JSON.stringify({
    body: state.body,
    isDraft: state.draft,
    isPrerelease: false,
    targetCommitish: state.target_commitish,
    name: state.name,
    tagName: state.tag_name,
  }));
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/commits/')) {
  process.stdout.write(process.env.FAKE_TARGET_COMMIT + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1].endsWith('/releases/latest')) {
  const state = readState();
  if (!state.latestTag) process.exit(1);
  process.stdout.write(state.latestTag + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/releases/tags/')) {
  process.stdout.write(JSON.stringify(apiRelease(readState())));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === '--method') {
  const state = readState();
  const apiPath = args[3];
  if (!apiPath.endsWith('/releases/' + state.id)) process.exit(1);
  state.draft = args.includes('draft=true');
  if (state.draft) state.latestTag = null;
  writeState(state);
  process.stdout.write(JSON.stringify(apiRelease(state)));
  process.exit(0);
}
if (args[0] === 'api' && args[1].includes('/releases/')) {
  process.stdout.write(JSON.stringify(apiRelease(readState())));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'download') {
  const pattern = args[args.indexOf('--pattern') + 1];
  const directory = args[args.indexOf('--dir') + 1];
  fs.copyFileSync(path.join(process.env.FAKE_FIXTURES, pattern), path.join(directory, pattern));
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'upload') {
  const state = readState();
  const filePath = args[3];
  const name = path.basename(filePath);
  let bytes = fs.readFileSync(filePath);
  if (process.env.FAKE_CORRUPT_UPLOAD === 'true' && name === 'latest.yml') {
    bytes = Buffer.concat([bytes, Buffer.from('corrupt')]);
  }
  state.assets = state.assets.filter(asset => asset.name !== name);
  state.assets.push({
    id: state.nextAssetId++,
    name,
    size: bytes.length,
    digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
  });
  writeState(state);
  process.exit(0);
}
if (args[0] === 'release' && args[1] === 'edit') {
  const state = readState();
  state.draft = false;
  state.latestTag = process.env.FAKE_LATEST_TAG || state.tag_name;
  writeState(state);
  process.exit(0);
}
process.stderr.write('Unexpected gh call: ' + args.join(' ') + '\\n');
process.exit(1);
`
  );
  await chmod(fakeGhPath, 0o755);

  const logPath = path.join(root, 'gh.log');
  const scriptPath = path.resolve('scripts/ci/promote-existing-draft.mjs');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${fetchHookPath}"`]
        .filter(Boolean)
        .join(' '),
      RELEASE_REPOSITORY: 'example/release-sandbox',
      RELEASE_TAG: tag,
      PROMOTE_DRY_RUN: 'false',
      PUBLISH_RELEASE: 'true',
      PROMOTION_OUTPUT_DIR: outputDirectory,
      FAKE_FIXTURES: fixtures,
      FAKE_GH_LOG: logPath,
      FAKE_RELEASE_STATE: statePath,
      FAKE_TARGET_COMMIT: targetCommit,
      ...overrides,
    },
  });
  const state = JSON.parse(await readFile(statePath, 'utf8')) as PromotionFixtureResult['state'];
  const calls = (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  return { result, state, calls, outputDirectory, tag };
}
describe('promote-existing-draft', () => {
  it('defines only Windows x64 source and updater aliases', () => {
    const layout = getPromotionLayout('2.9.0');

    expect(layout.sourceAssets).toEqual(['Agent.Teams.AI.Setup.2.9.0.exe']);
    expect(layout.stableAliases).toEqual({
      'Agent.Teams.AI.Setup.exe': 'Agent.Teams.AI.Setup.2.9.0.exe',
    });
    expect(layout.legacyStableAliases).toEqual({
      'Claude-Agent-Teams-UI-Setup.exe': 'Agent.Teams.AI.Setup.2.9.0.exe',
    });
    expect(layout.legacyUpdaterAliases).toEqual({
      'Claude.Agent.Teams.UI.Setup.2.9.0.exe': 'Agent.Teams.AI.Setup.2.9.0.exe',
    });
    expect(layout.feedSources).toEqual({
      windowsX64: 'Agent.Teams.AI.Setup.2.9.0.exe',
    });
  });

  it('rejects ambiguous publication settings', () => {
    expect(() =>
      parsePromotionConfig({
        RELEASE_REPOSITORY: '777genius/agent-teams-ai',
        RELEASE_TAG: 'v2.9.0',
        PROMOTE_DRY_RUN: 'true',
        PUBLISH_RELEASE: 'true',
      })
    ).toThrow('cannot be combined');
  });

  it('builds only latest.yml from exact Windows x64 artifact bytes', async () => {
    const directory = await makeTemporaryDirectory('promote-feeds-');
    const layout = getPromotionLayout('2.9.0');
    const assetPath = path.join(directory, layout.feedSources.windowsX64);
    const assetBytes = Buffer.from(`fixture:${layout.feedSources.windowsX64}`);
    await writeFile(assetPath, assetBytes);

    const feeds = await buildUpdaterFeeds({
      directory,
      version: '2.9.0',
      releaseDate: '2026-07-19T00:00:00.000Z',
      feedSources: layout.feedSources,
    });

    const windowsSha = createHash('sha512').update(assetBytes).digest('base64');
    expect(Object.keys(feeds)).toEqual(['latest.yml']);
    expect(parse(feeds['latest.yml'])).toMatchObject({
      version: '2.9.0',
      path: layout.feedSources.windowsX64,
      sha512: windowsSha,
      files: [{ url: layout.feedSources.windowsX64, sha512: windowsSha, size: assetBytes.length }],
    });
  });

  it('embeds migration notes as a safe YAML scalar in the x64 feed', async () => {
    const directory = await makeTemporaryDirectory('promote-notes-');
    const layout = getPromotionLayout('2.17.10');
    await writeFile(
      path.join(directory, layout.feedSources.windowsX64),
      `fixture:${layout.feedSources.windowsX64}`
    );
    const releaseNotes =
      '## Windows: manual install\nUse the "Setup" once.\n\n```yaml\nversion: other\n```';
    const feeds = await buildUpdaterFeeds({
      directory,
      version: '2.17.10',
      releaseDate: '2026-10-09T00:00:00.000Z',
      feedSources: layout.feedSources,
      releaseNotes,
    });

    expect(Object.keys(feeds)).toEqual(['latest.yml']);
    expect(parse(feeds['latest.yml'])).toMatchObject({ version: '2.17.10', releaseNotes });
  });

  it('feeds the Windows x64 update through electron-updater eligibility checks', async () => {
    const directory = await makeTemporaryDirectory('updater-compatibility-TEST-');
    const layout = getPromotionLayout('9.9.9');
    await writeFile(
      path.join(directory, layout.feedSources.windowsX64),
      `fixture:${layout.feedSources.windowsX64}`
    );
    const feeds = await buildUpdaterFeeds({
      directory,
      version: '9.9.9',
      releaseDate: '2026-09-28T00:00:00.000Z',
      feedSources: layout.feedSources,
    });
    const updater = new FeedCompatibilityUpdater(feeds['latest.yml'], directory);
    const available = vi.fn();
    const unavailable = vi.fn();
    updater.on('update-available', available);
    updater.on('update-not-available', unavailable);
    const result = await updater.checkForUpdates();
    expect(result?.isUpdateAvailable).toBe(true);
    expect(available).toHaveBeenCalledTimes(1);
    expect(unavailable).not.toHaveBeenCalled();
  });

  // The fake gh executable uses a POSIX shebang and PATH separator.
  it.skipIf(process.platform === 'win32')(
    'publishes and verifies only Windows x64 updater assets',
    async () => {
      const { result, state, calls, outputDirectory, tag } = await runFakePromotion();
      const version = tag.slice(1);
      const layout = getPromotionLayout(version);
      const outputNames = (await readdir(outputDirectory)).sort();
      const expectedNames = [
        layout.sourceAssets[0],
        ...Object.keys(layout.stableAliases),
        ...Object.keys(layout.legacyStableAliases),
        ...Object.keys(layout.legacyUpdaterAliases),
        'latest.yml',
      ].sort();

      expect(result.status, result.stderr).toBe(0);
      expect(state.draft).toBe(false);
      expect(state.latestTag).toBe(tag);
      expect(outputNames).toEqual(expectedNames);
      const releaseAssetNames = [...expectedNames, `${layout.sourceAssets[0]}.blockmap`].sort();
      expect(state.assets.map((asset) => asset.name).sort()).toEqual(releaseAssetNames);
      expect(state.assets.find((asset) => asset.name === layout.sourceAssets[0])?.id).toBe(1);
      expect(
        state.assets.find((asset) => asset.name === `${layout.sourceAssets[0]}.blockmap`)?.id
      ).toBe(2);
      expect(calls.filter((args) => args[0] === 'release' && args[1] === 'download')).toHaveLength(
        1
      );
      expect(calls.filter((args) => args[0] === 'release' && args[1] === 'upload')).toHaveLength(
        4
      );
      expect(
        calls.some(
          (args) =>
            args[0] === 'release' &&
            args[1] === 'edit' &&
            args.includes('--draft=false') &&
            args.includes('--latest')
        )
      ).toBe(true);
      expect(parse(await readFile(path.join(outputDirectory, 'latest.yml'), 'utf8'))).toMatchObject({
        version,
        releaseNotes: 'Release notes',
      });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to publish when an uploaded Windows x64 asset fails integrity verification',
    async () => {
      const { result, state, calls } = await runFakePromotion({ FAKE_CORRUPT_UPLOAD: 'true' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Uploaded release asset integrity mismatch: latest.yml');
      expect(state.draft).toBe(true);
      expect(state.latestTag).toBeNull();
      expect(calls.some((args) => args[0] === 'release' && args[1] === 'edit')).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'redrafts a release if latest-tag verification fails after publication',
    async () => {
      const { result, state, calls, tag } = await runFakePromotion({
        FAKE_LATEST_TAG: 'v9.9.8',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`expected ${tag}`);
      expect(state.draft).toBe(true);
      expect(state.latestTag).toBeNull();
      expect(calls).toContainEqual([
        'api',
        '--method',
        'PATCH',
        'repos/example/release-sandbox/releases/123',
        '-F',
        'draft=true',
        '-f',
        'make_latest=false',
      ]);
    }
  );
});
