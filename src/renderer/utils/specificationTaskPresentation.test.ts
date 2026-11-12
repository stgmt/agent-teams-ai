import { describe, expect, it } from 'vitest';

import {
  formatSpecificationTaskLabel,
  getSpecificationBindingKey,
  getSpecificationTaskScope,
  isSpecificationTask,
  resolveSpecificationBinding,
} from './specificationTaskPresentation';

describe('specification task presentation', () => {
  it('distinguishes equal display numbers from different specifications', () => {
    const first = {
      id: 'registry-first',
      displayId: 'TASK-12',
      specProject: 'product',
      specSlug: 'editor',
      registryLocalId: 'TASK-12',
      registryStatus: 'blocked',
      requirements: ['FR-1'],
    };
    const second = {
      ...first,
      id: 'registry-second',
      specSlug: 'api',
      registryStatus: 'deferred',
      requirements: ['NFR-2'],
    };

    expect(formatSpecificationTaskLabel(first)).toBe('product/editor · TASK-12');
    expect(formatSpecificationTaskLabel(second)).toBe('product/api · TASK-12');
    expect(formatSpecificationTaskLabel(first)).not.toBe(formatSpecificationTaskLabel(second));
  });

  it('does not fabricate registry identity for local or incomplete tasks', () => {
    const localTask = { id: 'local-1', displayId: 'TASK-12' };

    expect(getSpecificationTaskScope(localTask)).toBeNull();
    expect(isSpecificationTask(localTask)).toBe(false);
    expect(formatSpecificationTaskLabel(localTask)).toBe('TASK-12');
    expect(
      isSpecificationTask({
        ...localTask,
        specProject: 'product',
        specSlug: 'editor',
        registryLocalId: 'TASK-12',
      })
    ).toBe(false);
  });

  it('preserves canonical registry status rather than deriving it from task workflow status', () => {
    const task = {
      id: 'registry-blocked',
      displayId: 'TASK-12',
      specProject: 'product',
      specSlug: 'editor',
      registryLocalId: 'TASK-12',
      registryStatus: 'blocked',
      requirements: [],
      status: 'in_progress',
    };

    expect(task.registryStatus).toBe('blocked');
    expect(task.status).toBe('in_progress');
    expect(task.requirements).toEqual([]);
    expect(isSpecificationTask(task)).toBe(true);
  });
  it('requires a choice when several specifications are linked', () => {
    const bindings = [
      { project: 'product', spec: 'editor' },
      { project: 'product', spec: 'api' },
    ];
    const selectedKey = getSpecificationBindingKey(bindings[1]);

    expect(resolveSpecificationBinding(bindings, '')).toBeNull();
    expect(resolveSpecificationBinding(bindings, selectedKey)).toEqual(bindings[1]);
    expect(resolveSpecificationBinding([bindings[0]], '')).toEqual(bindings[0]);
    expect(resolveSpecificationBinding(bindings, 'stale-selection')).toBeNull();
  });
});
