import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const LOCALES_DIR = path.resolve(__dirname, '../../../localization/renderer/locales');

const REQUIRED_KEYS = [
  'title',
  'exitedAt',
  'exitedNormally',
  'exitedNoCode',
  'consequence',
  'queued',
  'savedForLater',
  'details',
  'close',
  'launch',
] as const;

function readNotRunning(locale: string): Record<string, unknown> | undefined {
  const team = JSON.parse(readFileSync(path.join(LOCALES_DIR, locale, 'team.json'), 'utf8')) as {
    detail?: { notRunning?: Record<string, unknown> };
  };
  return team.detail?.notRunning;
}

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));

describe('detail.notRunning locale keys (NM-S22)', () => {
  it('covers every shipped locale', () => {
    expect(locales).toContain('en');
    expect(locales).toContain('ru');
    expect(locales.length).toBeGreaterThanOrEqual(27);
  });

  it.each(locales)('%s has all keys as non-empty strings', (locale) => {
    const block = readNotRunning(locale);

    expect(block, `${locale}/team.json: detail.notRunning`).toBeDefined();
    for (const key of REQUIRED_KEYS) {
      expect(typeof block?.[key], `${locale}: ${key}`).toBe('string');
      expect((block?.[key] as string).trim(), `${locale}: ${key}`).not.toBe('');
    }
    expect(Object.keys(block ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(
      [...REQUIRED_KEYS].sort((a, b) => a.localeCompare(b))
    );
  });

  it('keeps the placeholders the dialog fills in, in every locale', () => {
    for (const locale of locales) {
      const block = readNotRunning(locale) as Record<string, string>;
      expect(block.title, locale).toContain('{{name}}');
      expect(block.exitedAt, locale).toContain('{{time}}');
      expect(block.exitedAt, locale).toContain('{{code}}');
      expect(block.exitedNormally, locale).toContain('{{time}}');
      expect(block.exitedNoCode, locale).toContain('{{time}}');
      expect(block.queued, locale).toContain('{{queued}}');
    }
  });

  it('has hand-written Russian text, not the English copy', () => {
    const en = readNotRunning('en') as Record<string, string>;
    const ru = readNotRunning('ru') as Record<string, string>;

    for (const key of REQUIRED_KEYS) {
      expect(ru?.[key], key).not.toBe(en?.[key]);
    }
  });
});
