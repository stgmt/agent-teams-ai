import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import type { CliProviderId, CliProviderStatus, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export type TeamModelRuntimeProviderStatus = Pick<
  CliProviderStatus,
  | 'providerId'
  | 'models'
  | 'modelCatalog'
  | 'modelCatalogRefreshState'
  | 'localRouterModelIds'
  | 'modelAvailability'
  | 'modelVerificationState'
  | 'runtimeCapabilities'
  | 'authMethod'
  | 'backend'
  | 'authenticated'
  | 'supported'
  | 'detailMessage'
  | 'availableBackends'
  | 'externalRuntimeDiagnostics'
  | 'connection'
  | 'statusCheckOutcome'
  | 'statusCheckErrorCode'
> &
  Partial<Pick<CliProviderStatus, 'verificationState' | 'statusMessage'>>;

function hasTeamProviderRuntimeModelTruth(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  if (!providerStatus) {
    return false;
  }

  if ((providerStatus.modelAvailability?.length ?? 0) > 0) {
    return true;
  }

  // A static fallback only keeps the picker populated while the real Codex
  // catalog loads. It must not make verification look complete.
  if (providerStatus.modelCatalog?.source === 'static-fallback') {
    return false;
  }

  return providerStatus.models.length > 0 || (providerStatus.modelCatalog?.models.length ?? 0) > 0;
}

export function isTeamProviderModelCatalogFresh(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null,
  nowMs = Date.now()
): boolean {
  const catalog = providerStatus?.modelCatalog;
  if (
    !providerId ||
    catalog?.providerId !== providerId ||
    catalog.status !== 'ready' ||
    providerStatus?.modelCatalogRefreshState !== 'ready'
  ) {
    return false;
  }

  const staleAtMs = Date.parse(catalog.staleAt);
  return Number.isFinite(staleAtMs) && staleAtMs > nowMs;
}

export function isTeamProviderModelCatalogSettled(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return Boolean(
    providerId &&
    providerStatus?.modelCatalog?.providerId === providerId &&
    providerStatus.modelCatalogRefreshState === 'ready'
  );
}

export function hasTerminalAuthoritativeModelVerification(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return Boolean(
    providerStatus?.statusCheckOutcome === 'authoritative' &&
    providerStatus.statusCheckErrorCode == null &&
    providerStatus.verificationState === 'verified' &&
    providerStatus.modelCatalogRefreshState === 'ready' &&
    providerStatus.modelCatalog?.status === 'ready' &&
    providerStatus.modelVerificationState !== 'verifying'
  );
}

export function isTeamProviderModelVerificationPending(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  if (!providerId || providerId === 'anthropic' || !providerStatus) {
    return false;
  }
  if (providerStatus.modelVerificationState === 'verifying') {
    return true;
  }

  const verificationState = providerStatus.verificationState;
  if (verificationState === 'error' || providerStatus.modelCatalogRefreshState === 'error') {
    return false;
  }

  const statusMessage = providerStatus.statusMessage?.trim().toLowerCase() ?? '';
  const statusMessagePending =
    statusMessage === 'checking...' ||
    statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE.toLowerCase();
  if (statusMessagePending && providerId !== 'opencode') {
    return true;
  }

  // A terminal catalog must not become an endless initial load.
  if (isTeamProviderModelCatalogSettled(providerId, providerStatus)) {
    return false;
  }

  const hasRuntimeModelTruth = hasTeamProviderRuntimeModelTruth(providerStatus);
  if (statusMessagePending || providerStatus.modelCatalogRefreshState === 'loading') {
    return !hasRuntimeModelTruth;
  }

  if (!hasRuntimeModelTruth) {
    if (
      providerId === 'codex' &&
      providerStatus.backend?.kind === 'codex-native' &&
      providerStatus.supported
    ) {
      return true;
    }

    if (
      providerId === 'opencode' &&
      providerStatus.backend?.kind === 'opencode-cli' &&
      providerStatus.supported
    ) {
      return true;
    }
  }

  if (providerStatus.verificationState !== 'unknown') {
    return false;
  }

  if (hasRuntimeModelTruth) {
    return false;
  }

  return statusMessage.length === 0 || statusMessage === 'checking...';
}
