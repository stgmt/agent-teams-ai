
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

const UPDATER_SKIP_MARKER = /\[(skip-updater|test-release|internal-release|no-autoupdate)\]/i;
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:[-.][A-Za-z0-9.-]+)?$/;

export function getPromotionLayout(version) {
  const windowsX64 = `Agent.Teams.AI.Setup.${version}.exe`;
  const stableAliases = {
    'Agent.Teams.AI.Setup.exe': windowsX64,
  };
  const legacyStableAliases = {
    'Claude-Agent-Teams-UI-Setup.exe': windowsX64,
  };
  const legacyUpdaterAliases = {
    [`Claude.Agent.Teams.UI.Setup.${version}.exe`]: windowsX64,
  };
  const feedSources = { windowsX64 };
  const sourceAssets = [...new Set([
    ...Object.values(stableAliases),
    ...Object.values(legacyStableAliases),
    ...Object.values(legacyUpdaterAliases),
    ...Object.values(feedSources),
  ])].sort();

  return {
    stableAliases,
    legacyStableAliases,
    legacyUpdaterAliases,
    feedSources,
    sourceAssets,
  };
}

function parseBoolean(value, name, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function parsePromotionConfig(environment = process.env) {
  const repository = environment.RELEASE_REPOSITORY || environment.GITHUB_REPOSITORY || '';
  const tag = environment.RELEASE_TAG || '';
  const match = tag.match(SEMVER_TAG);

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('RELEASE_REPOSITORY or GITHUB_REPOSITORY must be owner/repository');
  }
  if (!match) {
    throw new Error(`RELEASE_TAG must be a semantic version tag, got '${tag || '<empty>'}'`);
  }

  const dryRun = parseBoolean(environment.PROMOTE_DRY_RUN, 'PROMOTE_DRY_RUN', false);
  const publishRelease = parseBoolean(environment.PUBLISH_RELEASE, 'PUBLISH_RELEASE', false);
  const allowPublishedRecovery = parseBoolean(
    environment.ALLOW_PUBLISHED_RELEASE_RECOVERY,
    'ALLOW_PUBLISHED_RELEASE_RECOVERY',
    false
  );
  if (dryRun && publishRelease) {
    throw new Error('PROMOTE_DRY_RUN=true cannot be combined with PUBLISH_RELEASE=true');
  }

  return {
    repository,
    tag,
    version: tag.slice(1),
    dryRun,
    publishRelease,
    allowPublishedRecovery,
    outputDirectory: environment.PROMOTION_OUTPUT_DIR
      ? path.resolve(environment.PROMOTION_OUTPUT_DIR)
      : null,
  };
}

function runCommand(command, args, { capture = false, environment = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const details = capture ? (result.stderr || result.stdout || '').trim() : '';
    const suffix = details ? `: ${details}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${suffix}`);
  }
  return capture ? result.stdout : '';
}

function runGh(args, options) {
  return runCommand('gh', args, options);
}

async function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest(encoding);
}

async function describeUpdaterAsset(directory, name) {
  const filePath = path.join(directory, name);
  const [fileStats, sha512] = await Promise.all([
    stat(filePath),
    hashFile(filePath, 'sha512', 'base64'),
  ]);
  return { name, size: fileStats.size, sha512 };
}


export async function buildUpdaterFeeds({
  directory,
  version,
  releaseDate,
  feedSources,
  releaseNotes = '',
}) {
  const windowsX64 = await describeUpdaterAsset(directory, feedSources.windowsX64);
  const latest = `version: ${version}
files:
  - url: ${windowsX64.name}
    sha512: ${windowsX64.sha512}
    size: ${windowsX64.size}
path: ${windowsX64.name}
sha512: ${windowsX64.sha512}
releaseDate: '${releaseDate}'
`;

  // JSON strings are YAML scalars: preserve Markdown/newlines without injecting feed keys.
  const notes = releaseNotes.trim() ? `releaseNotes: ${JSON.stringify(releaseNotes)}\n` : '';
  return { 'latest.yml': latest + notes };
}
async function validateWindowsUpdaterFeed(directory, version, sourceName, feedPath) {
  const raw = await readFile(feedPath, 'utf8');
  const feed = parse(raw);
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error('Invalid Windows x64 updater feed');
  }
  const files = feed.files;
  const expected = await describeUpdaterAsset(directory, sourceName);
  if (
    feed.version !== version ||
    feed.path !== sourceName ||
    feed.sha512 !== expected.sha512 ||
    !Array.isArray(files) ||
    files.length !== 1 ||
    files[0]?.url !== sourceName ||
    files[0]?.size !== expected.size ||
    files[0]?.sha512 !== expected.sha512
  ) {
    throw new Error(`Invalid Windows x64 updater feed: ${feedPath}`);
  }
}


async function linkOrCopy(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code !== 'EXDEV' && error?.code !== 'EPERM') {
      throw error;
    }
    await copyFile(source, destination);
  }
}

async function uploadWithRetry({ repository, tag, filePath, environment }) {
  const args = ['release', 'upload', tag, filePath, '--repo', repository, '--clobber'];
  try {
    runGh(args, { environment });
  } catch (firstError) {
    process.stderr.write(`Retrying upload for ${path.basename(filePath)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      runGh(args, { environment });
    } catch (secondError) {
      secondError.cause = firstError;
      throw secondError;
    }
  }
}

function validateRelease(release, config) {
  if (release.tagName !== config.tag) {
    throw new Error(`Release tag is ${release.tagName}, expected ${config.tag}`);
  }
  if (!release.isDraft && !config.allowPublishedRecovery) {
    throw new Error(`${config.tag} is not a draft`);
  }
  if (release.isPrerelease) {
    throw new Error(`${config.tag} is a prerelease`);
  }
  if (UPDATER_SKIP_MARKER.test(`${release.name || ''}\n${release.body || ''}`)) {
    throw new Error(`${config.tag} contains an updater skip marker`);
  }
}

function carryPrepareArguments(environment) {
  const variables = [
    ['--release-tag', 'RELEASE_TAG'],
    ['--application-sha', 'RELEASE_APPLICATION_SHA'],
    ['--tooling-sha', 'RELEASE_TOOLING_SHA'],
    ['--mac-source-tag', 'MAC_SOURCE_TAG'],
    ['--output', 'PROMOTION_OUTPUT_DIR'],
    ['--build-run-id', 'RELEASE_BUILD_RUN_ID'],
    ['--build-attempt', 'RELEASE_BUILD_ATTEMPT'],
    ['--build-job-ids', 'RELEASE_BUILD_JOB_IDS'],
  ];
  return [
    '--repository',
    environment.RELEASE_REPOSITORY || environment.GITHUB_REPOSITORY || '',
    '--mode',
    'carry-mac',
    ...variables.flatMap(([flag, variable]) => [flag, environment[variable] || '']),
  ];
}

function delegateCarryAssembly(environment) {
  if (environment.PUBLISH_RELEASE === 'true')
    throw new Error(
      'Carry publication requires separate native evidence and an approved publication operation'
    );
  const operation = environment.PROMOTION_OPERATION || 'prepare';
  if (operation !== 'prepare' && operation !== 'stage-draft')
    throw new Error('PROMOTION_OPERATION must be prepare or stage-draft');
  const args =
    operation === 'prepare'
      ? carryPrepareArguments(environment)
      : [
          '--plan',
          environment.RELEASE_STAGE_PLAN || '',
          '--plan-digest',
          environment.RELEASE_STAGE_PLAN_DIGEST || '',
        ];
  if (operation === 'stage-draft' && environment.PROMOTE_DRY_RUN === 'true')
    throw new Error('Use prepare for a read-only carry dry run');
  const script = operation === 'prepare' ? 'prepare-existing-draft.ts' : 'stage-existing-draft.ts';
  runCommand('pnpm', ['exec', 'tsx', `scripts/ci/${script}`, ...args], { environment });
  return { mode: 'carry-mac', operation, published: false };
}

async function prepareAliases(outputDirectory, layout) {
  const aliasGroups = [
    ['stable', layout.stableAliases],
    ['legacy stable', layout.legacyStableAliases],
    ['legacy updater', layout.legacyUpdaterAliases],
  ];
  const aliasPaths = [];
  for (const [label, aliases] of aliasGroups) {
    for (const [aliasName, sourceName] of Object.entries(aliases)) {
      process.stdout.write(`Preparing ${label} alias: ${aliasName} -> ${sourceName}\n`);
      const aliasPath = path.join(outputDirectory, aliasName);
      await rm(aliasPath, { force: true });
      await linkOrCopy(path.join(outputDirectory, sourceName), aliasPath);
      aliasPaths.push(aliasPath);
    }
  }
  return aliasPaths;
}

async function uploadPreparedFiles(config, filePaths, environment) {
  for (const filePath of filePaths) {
    await uploadWithRetry({
      repository: config.repository,
      tag: config.tag,
      filePath,
      environment,
    });
  }
}

function validatedSourceAssets(release, sourceNames) {
  const assetsByName = new Map();
  for (const asset of release.assets || []) {
    if (!asset?.name || assetsByName.has(asset.name)) {
      throw new Error(`Release contains a missing or duplicate asset name: ${asset?.name || '<empty>'}`);
    }
    assetsByName.set(asset.name, asset);
  }
  for (const sourceName of sourceNames) {
    const asset = assetsByName.get(sourceName);
    if (!asset) throw new Error(`Missing source release asset ${sourceName}`);
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error(`Missing asset identity for source release asset ${sourceName}`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Missing or invalid size for source release asset ${sourceName}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) {
      throw new Error(`Missing SHA-256 digest for source release asset ${sourceName}`);
    }
  }
  return assetsByName;
}

async function describePreparedAsset(filePath) {
  const [fileStats, sha256] = await Promise.all([
    stat(filePath),
    hashFile(filePath, 'sha256', 'hex'),
  ]);
  if (!fileStats.isFile() || fileStats.size <= 0) {
    throw new Error(`Prepared release asset is empty or not a file: ${filePath}`);
  }
  return {
    name: path.basename(filePath),
    size: fileStats.size,
    digest: `sha256:${sha256}`,
  };
}

function assertReleaseIdentity(release, config, releaseId, resolvedTagCommit) {
  if (release.id !== releaseId || release.tag_name !== config.tag) {
    throw new Error(`Release identity changed while promoting ${config.tag}`);
  }
  if (release.target_commitish !== resolvedTagCommit) {
    throw new Error(
      `${config.tag} release targets ${release.target_commitish}, but the tag resolves to ${resolvedTagCommit}`
    );
  }
}

function assertReleaseEligibility(release) {
  if (
    release.prerelease ||
    UPDATER_SKIP_MARKER.test(`${release.name || ''}\n${release.body || ''}`)
  ) {
    throw new Error('Release is prerelease or has an updater skip marker');
  }
}

function assertWindowsAssetSnapshot(release, sourceAssets, sourceNames, preparedAssets) {
  const assetsByName = validatedSourceAssets(release, sourceNames);
  for (const sourceName of sourceNames) {
    const original = sourceAssets.get(sourceName);
    const current = assetsByName.get(sourceName);
    if (
      !original ||
      current.id !== original.id ||
      current.size !== original.size ||
      current.digest !== original.digest
    ) {
      throw new Error(`Source asset identity changed while promoting ${sourceName}`);
    }
  }
  for (const expected of preparedAssets) {
    const actual = assetsByName.get(expected.name);
    if (!actual) throw new Error(`Uploaded release asset is missing: ${expected.name}`);
    if (
      !Number.isSafeInteger(actual.id) ||
      actual.id <= 0 ||
      actual.size !== expected.size ||
      actual.digest !== expected.digest
    ) {
      throw new Error(`Uploaded release asset integrity mismatch: ${expected.name}`);
    }
  }
}

async function requestPublicResponse(url, method = 'GET') {
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    ...(method === 'GET' ? { headers: { Accept: 'application/vnd.github+json' } } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = new Error(`Anonymous release check failed: ${url} (HTTP ${response.status})`);
    error.httpStatus = response.status;
    throw error;
  }
  return response;
}

async function verifyPublicWindowsReleaseOnce({ config, releaseId, assetNames }) {
  const apiRoot = `https://api.github.com/repos/${config.repository}`;
  const assertPublicSnapshot = async () => {
    const [releaseResponse, latestResponse] = await Promise.all([
      requestPublicResponse(`${apiRoot}/releases/tags/${config.tag}`),
      requestPublicResponse(`${apiRoot}/releases/latest`),
    ]);
    const [release, latest] = await Promise.all([
      releaseResponse.json(),
      latestResponse.json(),
    ]);
    for (const [name, value] of [
      ['published release', release],
      ['latest release', latest],
    ]) {
      if (
        value.id !== releaseId ||
        value.tag_name !== config.tag ||
        value.draft ||
        value.prerelease
      ) {
        throw new Error(`Anonymous ${name} visibility mismatch for ${config.tag}`);
      }
    }
  };

  await assertPublicSnapshot();
  for (const assetName of assetNames) {
    const encodedName = encodeURIComponent(assetName);
    for (const url of [
      `https://github.com/${config.repository}/releases/download/${config.tag}/${encodedName}`,
      `https://github.com/${config.repository}/releases/latest/download/${encodedName}`,
    ]) {
      await requestPublicResponse(url, 'HEAD');
    }
  }
  await assertPublicSnapshot();
}

async function verifyPublicWindowsRelease(input) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await verifyPublicWindowsReleaseOnce(input);
      return;
    } catch (error) {
      const status = error?.httpStatus;
      const transient =
        status === 408 ||
        status === 429 ||
        (status >= 500 && status <= 599) ||
        /ECONN|ETIMEDOUT|fetch failed|timed out/i.test(
          error instanceof Error ? `${error.name} ${error.message}` : String(error)
        );
      if (!transient || attempt === 6) throw error;
      process.stderr.write(
        `[release-updater-guard] Public Windows verification transient failure; retry ${attempt + 1}/6\n`
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

async function verifyWindowsReleaseAssets({
  config,
  environment,
  releaseId,
  resolvedTagCommit,
  sourceAssets,
  sourceNames,
  preparedAssets,
  requirePublished = false,
}) {
  const readCurrentRelease = () =>
    JSON.parse(
      runGh(
        ['api', `repos/${config.repository}/releases/tags/${config.tag}`],
        { capture: true, environment }
      )
    );
  const release = readCurrentRelease();
  assertReleaseIdentity(release, config, releaseId, resolvedTagCommit);
  assertReleaseEligibility(release);
  if (requirePublished && release.draft) {
    throw new Error(`${config.tag} remains a draft after publication`);
  }
  assertWindowsAssetSnapshot(release, sourceAssets, sourceNames, preparedAssets);

  if (requirePublished) {
    const latestTag = runGh(
      ['api', `repos/${config.repository}/releases/latest`, '--jq', '.tag_name'],
      { capture: true, environment }
    ).trim();
    if (latestTag !== config.tag) {
      throw new Error(`Latest published release is ${latestTag || '<none>'}, expected ${config.tag}`);
    }
    await verifyPublicWindowsRelease({
      config,
      releaseId,
      assetNames: [...sourceNames, ...preparedAssets.map((asset) => asset.name)],
    });
    const finalRelease = readCurrentRelease();
    assertReleaseIdentity(finalRelease, config, releaseId, resolvedTagCommit);
    assertReleaseEligibility(finalRelease);
    if (finalRelease.draft) {
      throw new Error(`${config.tag} became a draft during public verification`);
    }
    assertWindowsAssetSnapshot(finalRelease, sourceAssets, sourceNames, preparedAssets);
    const currentTagCommit = runGh(
      ['api', `repos/${config.repository}/commits/${config.tag}`, '--jq', '.sha'],
      { capture: true, environment }
    ).trim();
    if (currentTagCommit !== resolvedTagCommit) {
      throw new Error(`${config.tag} changed during public release verification`);
    }
    const finalLatestTag = runGh(
      ['api', `repos/${config.repository}/releases/latest`, '--jq', '.tag_name'],
      { capture: true, environment }
    ).trim();
    if (finalLatestTag !== config.tag) {
      throw new Error(`Latest published release changed during verification: ${finalLatestTag}`);
    }
  }
  return release;
}

async function redraftIncompleteRelease({
  config,
  environment,
  releaseId,
  resolvedTagCommit,
}) {
  const releasePath = `repos/${config.repository}/releases/${releaseId}`;
  const release = JSON.parse(
    runGh(['api', releasePath], { capture: true, environment })
  );
  assertReleaseIdentity(release, config, releaseId, resolvedTagCommit);
  if (release.draft) return;
  runGh(
    [
      'api',
      '--method',
      'PATCH',
      releasePath,
      '-F',
      'draft=true',
      '-f',
      'make_latest=false',
    ],
    { environment }
  );
  const redrafted = JSON.parse(runGh(['api', releasePath], { capture: true, environment }));
  assertReleaseIdentity(redrafted, config, releaseId, resolvedTagCommit);
  if (!redrafted.draft) {
    throw new Error(`Failed to return incomplete release ${config.tag} to draft`);
  }
}

export async function promoteExistingDraft({
  environment = process.env,
  now = () => new Date(),
} = {}) {
  const mode = environment.RELEASE_MODE || 'full';
  if (mode !== 'full' && mode !== 'carry-mac')
    throw new Error('RELEASE_MODE must be full or carry-mac');
  if (mode === 'carry-mac') return delegateCarryAssembly(environment);
  const config = parsePromotionConfig(environment);
  if (
    config.tag === 'v2.17.7' ||
    config.tag === 'v2.17.8' ||
    config.tag === 'v2.17.9' ||
    config.tag === 'v2.17.10'
  )
    throw new Error(
      'Full220 requires publish-full-release.ts with immutable prepared plan and native receipt; legacy feed regeneration is forbidden'
    );
  const layout = getPromotionLayout(config.version);
  const blockmapName = `${layout.feedSources.windowsX64}.blockmap`;
  const releaseSourceNames = [...layout.sourceAssets, blockmapName];
  const release = JSON.parse(
    runGh(
      [
        'release',
        'view',
        config.tag,
        '--repo',
        config.repository,
        '--json',
        'body,isDraft,isPrerelease,targetCommitish,name,tagName',
      ],
      { capture: true, environment }
    )
  );
  validateRelease(release, config);

  const resolvedTagCommit = runGh(
    ['api', `repos/${config.repository}/commits/${config.tag}`, '--jq', '.sha'],
    { capture: true, environment }
  ).trim();
  if (release.targetCommitish !== resolvedTagCommit) {
    throw new Error(
      `${config.tag} draft targets ${release.targetCommitish}, but the tag resolves to ${resolvedTagCommit}`
    );
  }

  const releaseIdentity = JSON.parse(
    runGh(
      ['api', `repos/${config.repository}/releases/tags/${config.tag}`],
      { capture: true, environment }
    )
  );
  if (
    !Number.isSafeInteger(releaseIdentity.id) ||
    releaseIdentity.id <= 0 ||
    releaseIdentity.tag_name !== config.tag ||
    releaseIdentity.target_commitish !== resolvedTagCommit
  ) {
    throw new Error(`Release identity or target changed before promoting ${config.tag}`);
  }
  const releaseId = releaseIdentity.id;
  const assetsByName = validatedSourceAssets(releaseIdentity, releaseSourceNames);

  const ownsOutputDirectory = !config.outputDirectory;
  const outputDirectory =
    config.outputDirectory ||
    (await mkdtemp(path.join(tmpdir(), 'agent-teams-release-promotion-')));
  await mkdir(outputDirectory, { recursive: true });

  try {
    for (const sourceName of layout.sourceAssets) {
      process.stdout.write(`Downloading and verifying ${sourceName}\n`);
      runGh(
        [
          'release',
          'download',
          config.tag,
          '--repo',
          config.repository,
          '--pattern',
          sourceName,
          '--dir',
          outputDirectory,
          '--clobber',
        ],
        { environment }
      );
      const sourceAsset = assetsByName.get(sourceName);
      const sourcePath = path.join(outputDirectory, sourceName);
      const downloadedStats = await stat(sourcePath);
      const actualDigest = await hashFile(sourcePath, 'sha256', 'hex');
      const expectedDigest = sourceAsset.digest.slice('sha256:'.length);
      if (downloadedStats.size !== sourceAsset.size || actualDigest !== expectedDigest) {
        throw new Error(
          `SHA-256 or size mismatch for ${sourceName}: expected ${sourceAsset.size} bytes / ${expectedDigest}, got ${downloadedStats.size} bytes / ${actualDigest}`
        );
      }
    }

    const aliasPaths = await prepareAliases(outputDirectory, layout);
    const feeds = await buildUpdaterFeeds({
      directory: outputDirectory,
      version: config.version,
      releaseDate: now().toISOString(),
      feedSources: layout.feedSources,
      releaseNotes: release.body || '',
    });
    const feedPaths = [];
    for (const [name, contents] of Object.entries(feeds)) {
      const feedPath = path.join(outputDirectory, name);
      await writeFile(feedPath, contents);
      feedPaths.push(feedPath);
    }
    await validateWindowsUpdaterFeed(
      outputDirectory,
      config.version,
      layout.feedSources.windowsX64,
      path.join(outputDirectory, 'latest.yml')
    );

    const preparedPaths = [...aliasPaths, ...feedPaths];
    const preparedAssets = await Promise.all(preparedPaths.map(describePreparedAsset));
    if (!config.dryRun) {
      await uploadPreparedFiles(config, preparedPaths, environment);
      try {
        await verifyWindowsReleaseAssets({
          config,
          environment,
          releaseId,
          resolvedTagCommit,
          sourceAssets: assetsByName,
          sourceNames: releaseSourceNames,
          preparedAssets,
        });
      } catch (error) {
        try {
          await redraftIncompleteRelease({
            config,
            environment,
            releaseId,
            resolvedTagCommit,
          });
        } catch (redraftError) {
          throw new AggregateError(
            [error, redraftError],
            `Windows asset verification failed and release ${config.tag} could not be safely redrafted`
          );
        }
        throw error;
      }
    }

    if (config.publishRelease) {
      try {
        runGh(
          ['release', 'edit', config.tag, '--repo', config.repository, '--draft=false', '--latest'],
          { environment }
        );
        await verifyWindowsReleaseAssets({
          config,
          environment,
          releaseId,
          resolvedTagCommit,
          sourceAssets: assetsByName,
          sourceNames: releaseSourceNames,
          preparedAssets,
          requirePublished: true,
        });
      } catch (error) {
        try {
          await redraftIncompleteRelease({
            config,
            environment,
            releaseId,
            resolvedTagCommit,
          });
        } catch (redraftError) {
          throw new AggregateError(
            [error, redraftError],
            `Windows release verification failed and ${config.tag} could not be safely redrafted`
          );
        }
        throw error;
      }
    }

    const result = {
      repository: config.repository,
      tag: config.tag,
      targetCommit: resolvedTagCommit,
      sourceAssets: layout.sourceAssets.length,
      aliases: aliasPaths.length,
      feeds: feedPaths.map((feedPath) => path.basename(feedPath)),
      dryRun: config.dryRun,
      published: config.publishRelease,
      outputDirectory: config.outputDirectory ? outputDirectory : undefined,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (ownsOutputDirectory) {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

const entryPointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryPointUrl === import.meta.url) {
  promoteExistingDraft().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
