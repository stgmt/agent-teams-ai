import type { NativeLanguageChangeNotifierDependencies } from './createNativeTeamProvisioningApis';
import type { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import type { TeamConfig } from '@shared/types';

/**
 * What the language notifier needs from the shell: the team configuration, the
 * system locale and the language naming rule. The message it sends back to a live
 * team comes from the root's own messaging surface, never from here.
 */
export interface NativeLanguageChangeProductionSources {
  config: Pick<TeamConfigReader, 'getConfig'> & {
    updateConfig(teamName: string, update: Pick<TeamConfig, 'language'>): Promise<void>;
  };
  getSystemLocale(): string;
  resolveLanguageName(code: string, systemLocale?: string): string;
  logger: { info(message: string): void; warn(message: string): void };
}

export function createNativeLanguageChangeDeps(
  sources: NativeLanguageChangeProductionSources
): NativeLanguageChangeNotifierDependencies {
  return {
    readConfig: (teamName) => sources.config.getConfig(teamName),
    writeLanguage: (teamName, language) =>
      sources.config.updateConfig(teamName, { language: language as TeamConfig['language'] }),
    getSystemLocale: () => sources.getSystemLocale(),
    resolveLanguageName: (code, systemLocale) => sources.resolveLanguageName(code, systemLocale),
    logger: sources.logger,
  };
}
