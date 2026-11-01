// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeLanguageChangeNotifier } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLanguageChangeNotifier';

import type { TeamConfig } from '../../../../src/shared/types';

/** `Promise.withResolvers` is outside this project's TS lib target. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function config(language: string): TeamConfig {
  return { name: 'alpha', language } as TeamConfig;
}

function setup(
  options: {
    teams?: readonly string[];
    configs?: Record<string, TeamConfig | null>;
    resolve?: (code: string) => string;
    sendFails?: string;
  } = {}
) {
  const configs = new Map<string, TeamConfig>(
    Object.entries(options.configs ?? {}).flatMap(([team, value]) =>
      value ? [[team, { ...value }] as const] : []
    )
  );
  const missing = new Set(
    Object.entries(options.configs ?? {}).flatMap(([team, value]) =>
      value === null ? [team] : []
    )
  );
  const writes = vi.fn(async (teamName: string, language: string) => {
    configs.set(teamName, { ...(configs.get(teamName) ?? config(language)), language });
  });
  const sends = vi.fn(async (teamName: string) => {
    if (options.sendFails === teamName) throw new Error('delivery refused');
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const notifier = new NativeLanguageChangeNotifier({
    getAliveTeams: () => options.teams ?? [...configs.keys()],
    readConfig: async (teamName) => (missing.has(teamName) ? null : (configs.get(teamName) ?? null)),
    writeLanguage: writes,
    sendMessageToTeam: sends,
    getSystemLocale: () => 'en-US',
    resolveLanguageName: (code) => (options.resolve ?? ((value: string) => value))(code),
    logger,
  });
  return { notifier, writes, sends, logger };
}

describe('native language change notifier', () => {
  it('leaves a team that already uses the new language untouched', async () => {
    const { notifier, writes, sends } = setup({ configs: { alpha: config('fr') } });

    await notifier.notify('fr');

    expect(sends).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it('tells the lead and then persists the new language', async () => {
    const { notifier, writes, sends, logger } = setup({ configs: { alpha: config('en') } });

    await notifier.notify('fr');

    expect(sends).toHaveBeenCalledWith(
      'alpha',
      expect.stringContaining('from "en" to "fr"')
    );
    expect(writes).toHaveBeenCalledWith('alpha', 'fr');
    // The config is written only after the lead was told.
    expect(sends.mock.invocationCallOrder[0]).toBeLessThan(writes.mock.invocationCallOrder[0]!);
    expect(logger.info).toHaveBeenCalledWith('[alpha] Notified about language change: en → fr');
  });

  it('persists the code without a message when both codes resolve to one language name', async () => {
    const { notifier, writes, sends } = setup({
      configs: { alpha: config('en-GB') },
      resolve: () => 'English',
    });

    await notifier.notify('en-US');

    expect(sends).not.toHaveBeenCalled();
    expect(writes).toHaveBeenCalledWith('alpha', 'en-US');
  });

  it('skips a team whose config disappeared and warns when one delivery fails', async () => {
    const { notifier, sends, logger } = setup({
      teams: ['gone', 'alpha', 'beta'],
      configs: { gone: null, alpha: config('en'), beta: config('en') },
      sendFails: 'alpha',
    });

    await notifier.notify('fr');

    expect(sends).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith('[alpha] Failed to notify language change: delivery refused');
    expect(sends).toHaveBeenCalledWith('beta', expect.stringContaining('"fr"'));
  });

  it('serializes concurrent changes instead of interleaving them', async () => {
    const order: string[] = [];
    const { promise: gate, resolve: release } = deferred();
    let call = 0;
    const notifier = new NativeLanguageChangeNotifier({
      getAliveTeams: () => ['alpha'],
      readConfig: async () => (config('en')),
      writeLanguage: async () => undefined,
      sendMessageToTeam: async () => {
        call += 1;
        order.push(`start-${call}`);
        if (call === 1) {
          await gate;
          order.push('end-1');
          return;
        }
        order.push('end-2');
      },
      getSystemLocale: () => 'en-US',
      resolveLanguageName: (code) => code,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    const first = notifier.notify('fr');
    const second = notifier.notify('de');
    // Let the first pass reach its awaited delivery before checking the order.
    const { promise: flushed, resolve: flush } = deferred();
    setImmediate(flush);
    await flushed;
    // The second pass cannot start before the first finishes.
    expect(order).toEqual(['start-1']);
    release();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('reports a failed pass to its caller without poisoning later passes', async () => {
    let launches = 0;
    const sends = vi.fn(async () => undefined);
    const notifier = new NativeLanguageChangeNotifier({
      getAliveTeams: () => {
        launches += 1;
        if (launches === 1) throw new Error('registry unavailable');
        return ['alpha'];
      },
      readConfig: async () => (config('en')),
      writeLanguage: async () => undefined,
      sendMessageToTeam: sends,
      getSystemLocale: () => 'en-US',
      resolveLanguageName: (code) => code,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await expect(notifier.notify('fr')).rejects.toThrow('registry unavailable');
    await expect(notifier.notify('fr')).resolves.toBeUndefined();
    expect(sends).toHaveBeenCalledTimes(1);
  });
});
