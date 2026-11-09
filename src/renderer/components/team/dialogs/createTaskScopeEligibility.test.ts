import { describe, expect, it } from 'vitest';

import { hasRequiredRegistryTaskInputs } from './createTaskScopeEligibility';

describe('registry task creation eligibility', () => {
  const binding = { project: 'product', spec: 'editor' };

  it('requires both a selected linked specification and at least one requirement', () => {
    expect(hasRequiredRegistryTaskInputs(null, ['FR-1'])).toBe(false);
    expect(hasRequiredRegistryTaskInputs(binding, [])).toBe(false);
    expect(hasRequiredRegistryTaskInputs(binding, ['FR-1'])).toBe(true);
  });
});
