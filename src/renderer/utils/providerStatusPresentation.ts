import type { CliProviderId } from '@shared/types';

export function getProviderLabel(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (200+ providers)';
  }
}

export function getProviderStatusColor(statusText: string, authenticated: boolean): string {
  if (statusText === 'Checking...') {
    return 'var(--color-text-secondary)';
  }

  return authenticated ? 'var(--color-positive-text)' : 'var(--color-text-muted)';
}
