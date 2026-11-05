import type { TeamProviderId } from '@shared/types';

/** Providers supported by the pinned native bootstrap and direct teammate runtime. */
export function isNativeRuntimeProvider(
  providerId: unknown
): providerId is Extract<TeamProviderId, 'anthropic' | 'codex' | 'gemini'> {
  return providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini';
}
