import { useAppTranslation } from '@features/localization/renderer';
import { getTeamProviderLabel as getCatalogTeamProviderLabel } from '@renderer/utils/teamModelCatalog';

import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';
import { sanitizeTeamName } from './createTeamSubmissionValidation';
import type { TeamProviderId } from '@shared/types';

type TeamTranslator = ReturnType<typeof useAppTranslation>['t'];

export function getProviderLabel(providerId: TeamProviderId): string {
  return getCatalogTeamProviderLabel(providerId) ?? 'Anthropic';
}

export function alignProvisioningChecks(
  existingChecks: ProvisioningProviderCheck[],
  providerIds: TeamProviderId[]
): ProvisioningProviderCheck[] {
  const existingByProviderId = new Map(
    existingChecks.map((check) => [check.providerId, check] as const)
  );
  return providerIds.map(
    (providerId) =>
      existingByProviderId.get(providerId) ?? {
        providerId,
        status: 'pending',
        backendSummary: null,
        details: [],
      }
  );
}

export function validateTeamNameInline(name: string, t: TeamTranslator): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const sanitized = sanitizeTeamName(trimmed);
  if (!sanitized) {
    return t('create.validation.nameMustContainLetterOrDigit');
  }
  if (sanitized.length > 64) {
    return t('create.validation.nameTooLong');
  }
  return null;
}

export function buildDefaultTeamDescription(teamName: string, t: TeamTranslator): string {
  const trimmedName = teamName.trim();
  return trimmedName.length > 0
    ? t('create.defaultDescription.named', { teamName: trimmedName })
    : t('create.defaultDescription.fallback');
}

export function isCurrentPrepareGeneration(ref: { current: number }, generation: number): boolean {
  return ref.current === generation;
}
