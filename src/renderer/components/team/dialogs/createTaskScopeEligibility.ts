import type { SpecificationBinding } from '@renderer/utils/specificationTaskPresentation';

export function hasRequiredRegistryTaskInputs(
  selectedBinding: SpecificationBinding | null,
  requirements: readonly string[]
): boolean {
  return selectedBinding !== null && requirements.length > 0;
}
