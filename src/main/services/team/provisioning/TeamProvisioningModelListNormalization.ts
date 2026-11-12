import type { CliProviderStatus } from '@shared/types';

export function normalizeProviderModelListModels(
  provider:
    | { defaultModel?: string | null; models?: (string | { id?: string; label?: string })[] }
    | undefined
): Set<string> {
  const models = new Set<string>();
  const defaultModel = provider?.defaultModel?.trim();
  if (defaultModel) {
    models.add(defaultModel);
  }
  for (const entry of provider?.models ?? []) {
    const modelId = typeof entry === 'string' ? entry : entry.id;
    const trimmed = modelId?.trim();
    if (trimmed) {
      models.add(trimmed);
    }
  }
  return models;
}
export interface ProviderModelListCommandResponse {
  schemaVersion?: number;
  providers?: Record<
    string,
    {
      defaultModel?: string | null;
      models?: (string | { id?: string; label?: string; description?: string })[];
    }
  >;
}

export interface RuntimeStatusCommandResponse {
  providers?: Record<string, Partial<CliProviderStatus>>;
}

export interface AuthStatusCommandResponse {
  provider?: string;
  status?: Partial<CliProviderStatus>;
  loggedIn?: boolean;
  authMethod?: string | null;
  providers?: Record<string, Partial<CliProviderStatus>>;
}
