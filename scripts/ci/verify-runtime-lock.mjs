#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateWindowsRuntimeLock } from '../lib/windows-runtime-lock.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const runtimeLockPath = path.join(repoRoot, 'runtime.lock.json');
const lock = JSON.parse(fs.readFileSync(runtimeLockPath, 'utf8'));

function fail(message) {
  console.error(`[verify-runtime-lock] ${message}`);
  process.exit(1);
}

try {
  validateWindowsRuntimeLock(lock);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

console.log('[verify-runtime-lock] OK');
