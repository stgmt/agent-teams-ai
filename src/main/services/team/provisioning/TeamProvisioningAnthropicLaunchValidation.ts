import {
  resolveAnthropicEffortSupport,
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/main';
import type { EffortLevel, TeamCreateRequest } from '@shared/types';
import { isAnthropicContextPolicyLaunchModelAvailable } from '@shared/utils/anthropicLaunchModel';

import { TeamLaunchValidationError } from './TeamLaunchValidationError';
import type { RuntimeProviderLaunchFacts } from './TeamProvisioningRuntimeLaunchSelection';

export function hasAuthoritativeAnthropicLaunchCatalog(
  facts: Pick<RuntimeProviderLaunchFacts, 'modelIds' | 'modelCatalog'>
): boolean {
  const catalog = facts.modelCatalog;
  if (!catalog || catalog.providerId !== 'anthropic') {
    return facts.modelIds.size > 0;
  }

  const hasVisibleModels = catalog.models.some(
    (model) => !model.hidden && Boolean(model.launchModel.trim() || model.id.trim())
  );
  if (!hasVisibleModels || catalog.status === 'unavailable') {
    return false;
  }

  if (catalog.source === 'static-fallback') {
    return false;
  }

  if (catalog.source === 'anthropic-compatible-api') {
    return catalog.status === 'ready';
  }

  return true;
}

export function resolveAnthropicSelectionFromFacts(params: {
  selectedModel?: string;
  limitContext?: boolean;
  facts: Pick<
    RuntimeProviderLaunchFacts,
    'modelCatalog' | 'modelIds' | 'runtimeCapabilities' | 'defaultModel'
  >;
}): ReturnType<typeof resolveAnthropicRuntimeSelection> {
  return resolveAnthropicRuntimeSelection({
    source: {
      modelCatalog: params.facts.modelCatalog,
      runtimeCapabilities: params.facts.runtimeCapabilities,
    },
    selectedModel: params.selectedModel,
    limitContext: params.limitContext === true,
    availableLaunchModels: params.facts.modelCatalog ? undefined : params.facts.modelIds,
    defaultLaunchModel: params.facts.defaultModel,
  });
}

export function formatAnthropicEffortSupportFailure(params: {
  effort: EffortLevel;
  modelLabel: string;
  supportedEfforts?: readonly EffortLevel[];
  kind:
    | 'unsupported-by-catalog'
    | 'unsupported-by-runtime-capability'
    | 'unverified-catalog-missing';
}): string {
  if (params.kind === 'unverified-catalog-missing') {
    return `Anthropic runtime catalog was unavailable, so effort "${params.effort}" for ${params.modelLabel} could not be verified.`;
  }

  const supported = params.supportedEfforts?.length
    ? ` Supported efforts: ${params.supportedEfforts.join(', ')}.`
    : '';
  const runtimeSuffix =
    params.kind === 'unsupported-by-runtime-capability'
      ? ' in the current runtime capability data'
      : ' in the current runtime';
  return `${params.modelLabel} does not support Anthropic effort "${params.effort}"${runtimeSuffix}.${supported}`;
}

export function validateAnthropicRuntimeLaunchSelection(params: {
  actorLabel: string;
  model?: string;
  effort?: EffortLevel;
  fastMode?: TeamCreateRequest['fastMode'];
  limitContext?: boolean;
  facts: RuntimeProviderLaunchFacts;
  anthropicFastModeDefault: boolean;
}): void {
  const selection = resolveAnthropicSelectionFromFacts({
    selectedModel: params.model,
    limitContext: params.limitContext,
    facts: params.facts,
  });
  const resolvedLaunchModel = selection.resolvedLaunchModel?.trim() || null;
  if (!resolvedLaunchModel) {
    throw new TeamLaunchValidationError(
      `${params.actorLabel} could not resolve the selected Anthropic model against the current runtime catalog.`
    );
  }
  const localRouterServesModel = (params.facts.localRouterModelIds ?? []).some((id) => {
    const routerModel = id.split('@')[0].trim();
    return (
      routerModel === resolvedLaunchModel || routerModel === params.model?.split('@')[0]?.trim()
    );
  });
  if (
    params.facts.modelIds.size > 0 &&
    hasAuthoritativeAnthropicLaunchCatalog(params.facts) &&
    !isAnthropicContextPolicyLaunchModelAvailable(params.facts.modelIds, resolvedLaunchModel) &&
    !localRouterServesModel
  ) {
    throw new TeamLaunchValidationError(
      `${params.actorLabel} resolves to Anthropic model "${resolvedLaunchModel}", but the current runtime does not list it as launchable.`
    );
  }
  if (params.effort) {
    const modelLabel = selection.displayName ?? resolvedLaunchModel;
    const effortSupport = resolveAnthropicEffortSupport({
      selection,
      effort: params.effort,
      runtimeCapabilities: params.facts.runtimeCapabilities,
    });
    const servedByLocalRouter =
      effortSupport.kind === 'unverified-catalog-missing' && localRouterServesModel;
    if (effortSupport.kind !== 'supported' && !servedByLocalRouter) {
      throw new TeamLaunchValidationError(
        `${params.actorLabel} uses Anthropic effort "${params.effort}", but ${formatAnthropicEffortSupportFailure(
          {
            effort: params.effort,
            modelLabel,
            kind: effortSupport.kind,
            supportedEfforts:
              effortSupport.kind === 'unverified-catalog-missing'
                ? undefined
                : effortSupport.supportedEfforts,
          }
        )}`
      );
    }
  }

  const fastResolution = resolveAnthropicFastMode({
    selection,
    selectedFastMode: params.fastMode,
    providerFastModeDefault: params.anthropicFastModeDefault,
  });
  if ((params.fastMode ?? 'inherit') === 'on' && !fastResolution.selectable) {
    throw new TeamLaunchValidationError(
      `${params.actorLabel} enables Anthropic Fast mode, but ${
        fastResolution.disabledReason ?? 'it is unavailable for the selected runtime or model.'
      }`
    );
  }
}
