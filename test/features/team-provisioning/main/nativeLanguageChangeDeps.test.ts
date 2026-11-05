// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeLanguageChangeDeps } from '../../../../src/features/team-provisioning/main/composition/createNativeLanguageChangeDeps';

describe('language change sources', () => {
  it('reads the team config and writes the language through the same reader', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const getConfig = vi.fn(async () => ({ language: 'system' }) as never);
    const deps = createNativeLanguageChangeDeps({
      config: { getConfig, updateConfig },
      getSystemLocale: () => 'ru-RU',
      resolveLanguageName: (code, locale) => `${code}@${locale ?? 'none'}`,
      logger: { info: () => undefined, warn: () => undefined },
    });

    await expect(deps.readConfig('TEST-team')).resolves.toEqual({ language: 'system' });
    await deps.writeLanguage('TEST-team', 'en');
    expect(updateConfig).toHaveBeenCalledWith('TEST-team', { language: 'en' });
    expect(deps.getSystemLocale()).toBe('ru-RU');
    expect(deps.resolveLanguageName('en', 'ru-RU')).toBe('en@ru-RU');
  });

  it('reports a missing team config as null instead of inventing one', async () => {
    const deps = createNativeLanguageChangeDeps({
      config: { getConfig: async () => null, updateConfig: async () => undefined },
      getSystemLocale: () => 'en-US',
      resolveLanguageName: (code) => code,
      logger: { info: () => undefined, warn: () => undefined },
    });

    await expect(deps.readConfig('TEST-team')).resolves.toBeNull();
  });
});
