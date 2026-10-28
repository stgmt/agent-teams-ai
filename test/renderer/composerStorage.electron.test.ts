// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

async function runElectron(profile: string, html: string): Promise<unknown> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  return new Promise((done, reject) => {
    const child = spawn(
      require('electron') as string,
      [resolve('test/fixtures/composerStorageElectron.cjs'), profile, html],
      {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
    }, 25_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const line = output.split(/\r?\n/).find((value) => value.startsWith('COMPOSER_RESULT='));
      if (code !== 0 || !line)
        reject(new Error(`TEST Electron exit ${code}: ${diagnostics.slice(-1500)}`));
      else done(JSON.parse(line.slice('COMPOSER_RESULT='.length)));
    });
  });
}

describe('composer in isolated Electron Chromium storage', () => {
  it('shows memory-only honestly and reconnects without losing text or invoking a transport', async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), 'TEST-composer-electron-'));
    try {
      const locale = JSON.parse(
        await readFile(resolve('src/features/localization/renderer/locales/en/team.json'), 'utf8')
      );
      const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
          alias: [
            {
              find: '@features/localization/renderer',
              replacement: 'virtual:composer-test-translation',
            },
            { find: '@features', replacement: resolve('src/features') },
            { find: '@renderer', replacement: resolve('src/renderer') },
            { find: '@shared', replacement: resolve('src/shared') },
          ],
        },
        define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"development"' },
        plugins: [
          {
            name: 'composer-test-translation',
            resolveId: (id) =>
              id === 'virtual:composer-test-translation' ? '\0composer-test-translation' : null,
            load: (id) =>
              id === '\0composer-test-translation'
                ? `const locale=${JSON.stringify(locale)};export const useAppTranslation=()=>({t:key=>key.split('.').reduce((v,k)=>v?.[k],locale)??key});`
                : null,
          },
        ],
        build: {
          write: false,
          minify: false,
          target: 'esnext',
          lib: {
            entry: resolve('test/fixtures/composerStorageRenderer.tsx'),
            formats: ['iife'],
            name: 'ComposerStorageTest',
          },
        },
      });
      const results = Array.isArray(result) ? result : [result];
      const outputs = results.flatMap((item) => ('output' in item ? item.output : []));
      const code = outputs
        .filter((item) => item.type === 'chunk')
        .map((item) => item.code)
        .join('\n');
      expect(code.length).toBeGreaterThan(0);
      const html = resolve(scratch, 'index.html');
      await writeFile(
        html,
        `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${code.replaceAll('</script', '<\\/script')}</script>`
      );
      expect(await runElectron(resolve(scratch, 'profile'), html)).toMatchObject({
        failed: { status: 'memory-only', saved: false, warning: true, rawError: false },
        recovered: { status: 'durable', saved: true },
        durableText: expect.stringContaining('TEST-newer'),
        reloadedText: expect.stringContaining('TEST-newer'),
        actionMode: 'delegate',
      });
    } finally {
      await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(
        (error: unknown) => {
          process.stderr.write(
            `TEST infrastructure: temporary profile cleanup failed (${error instanceof Error ? error.name : 'UnknownError'}).\n`
          );
        }
      );
    }
  }, 60_000);
});
