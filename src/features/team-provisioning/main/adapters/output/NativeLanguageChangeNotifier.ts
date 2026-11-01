import { notifyAliveTeamsAboutLanguageChangeWithPorts } from '@main/services/team/provisioning/TeamProvisioningLanguageChangeNotification';

import type { TeamConfig } from '@shared/types';

export interface NativeLanguageChangeNotifierDependencies {
  /** Alive teams under the native run registry. */
  getAliveTeams(): readonly string[];
  readConfig(teamName: string): Promise<TeamConfig | null>;
  /** CAS write under the pinned CLI `.config.lock` protocol. */
  writeLanguage(teamName: string, language: string): Promise<void>;
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
  getSystemLocale(): string;
  resolveLanguageName(code: string, systemLocale?: string): string;
  logger: { info(message: string): void; warn(message: string): void };
}

/**
 * Replaces the legacy `notifyLanguageChange` host hook with a native adapter.
 *
 * The per-team policy (skip an unchanged language, update config without a
 * message when both codes resolve to the same name, otherwise tell the lead and
 * persist) is the shared pure function, so wording and ordering cannot drift.
 * Only the serialization and the native collaborators live here.
 */
export class NativeLanguageChangeNotifier {
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NativeLanguageChangeNotifierDependencies) {}

  /** Serialized like the legacy owner: concurrent changes are applied in order. */
  notify(newLangCode: string): Promise<void> {
    const next = this.inFlight.then(() =>
      notifyAliveTeamsAboutLanguageChangeWithPorts(newLangCode, {
        getAliveTeams: () => this.deps.getAliveTeams(),
        readConfigForStrictDecision: (teamName) => this.deps.readConfig(teamName),
        updateConfig: (teamName, update) =>
          this.deps.writeLanguage(teamName, update.language ?? 'system'),
        sendMessageToTeam: (teamName, message) => this.deps.sendMessageToTeam(teamName, message),
        getSystemLocale: () => this.deps.getSystemLocale(),
        resolveLanguageName: (code, systemLocale) => this.deps.resolveLanguageName(code, systemLocale),
        logger: this.deps.logger,
      })
    );
    // A failed pass must not poison later ones; the caller still sees this failure.
    this.inFlight = next.catch(() => undefined);
    return next;
  }
}
