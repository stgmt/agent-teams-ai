#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesRuntimeCliVersion } from '../lib/runtime-cli-version.mjs';
import { validateWindowsRuntimeLock } from '../lib/windows-runtime-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'runtime.lock.json'), 'utf8'));
validateWindowsRuntimeLock(lock);
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(
    `Staged Windows runtime verification requires Windows x64, got ${process.platform}/${process.arch}`
  );
}
const platform = 'win32-x64';
const asset = lock.assets[platform];
const runtimeDir = path.join(root, 'resources/runtime');
if (fs.readFileSync(path.join(runtimeDir, 'VERSION'), 'utf8').trim() !== lock.version) {
  throw new Error(`Staged runtime VERSION mismatch for ${platform}`);
}
if (fs.readFileSync(path.join(runtimeDir, 'COMMIT_SHA'), 'utf8').trim() !== lock.sourceCommit) {
  throw new Error(`Staged runtime source commit mismatch for ${platform}`);
}
const binary = path.join(runtimeDir, asset.binaryName);
const result = spawnSync(binary, ['--version'], {
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (
  result.error ||
  result.status !== 0 ||
  !matchesRuntimeCliVersion(result.stdout, lock.cliVersion)
) {
  const actualVersion =
    result.stdout?.trim() || result.error?.message || String(result.status);
  throw new Error(
    `Staged runtime CLI version check failed for ${platform}. Expected ${lock.cliVersion}, got ${actualVersion}`
  );
}
console.log(`Verified staged runtime ${lock.version} (${lock.cliVersion}) for ${platform}`);
