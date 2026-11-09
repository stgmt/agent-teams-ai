import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import type { TeamSpecBinding } from '@shared/types';

export type SpecificationBinding = TeamSpecBinding;

export function getSpecificationBindingKey(binding: SpecificationBinding): string {
  return JSON.stringify([binding.project, binding.spec]);
}

export function formatSpecificationBindingLabel(binding: SpecificationBinding): string {
  return `${binding.project}/${binding.spec}`;
}

export function resolveSpecificationBinding(
  bindings: readonly SpecificationBinding[],
  selectedKey: string
): SpecificationBinding | null {
  if (selectedKey) {
    return bindings.find((binding) => getSpecificationBindingKey(binding) === selectedKey) ?? null;
  }

  return bindings.length === 1 ? (bindings[0] ?? null) : null;
}

export interface SpecificationTaskIdentity {
  id: string;
  displayId?: string;
  specProject?: string;
  specSlug?: string;
  registryLocalId?: string;
  registryStatus?: string;
  requirements?: readonly string[];
  registryEntity?: Record<string, unknown>;
}

export function getSpecificationTaskScope(task: SpecificationTaskIdentity): string | null {
  if (
    !task.specProject?.trim() ||
    !task.specSlug?.trim() ||
    !task.registryLocalId?.trim() ||
    !task.registryStatus
  ) {
    return null;
  }

  return `${task.specProject}/${task.specSlug}`;
}

export function formatSpecificationTaskLabel(task: SpecificationTaskIdentity): string {
  const displayLabel = getTaskDisplayId(task);
  const scope = getSpecificationTaskScope(task);
  return scope ? `${scope} · ${displayLabel}` : displayLabel;
}

export function isSpecificationTask(task: SpecificationTaskIdentity): boolean {
  return getSpecificationTaskScope(task) !== null;
}
