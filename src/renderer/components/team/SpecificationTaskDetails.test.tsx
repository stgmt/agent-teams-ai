import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        'taskDetail.specification.ariaLabel': 'Specification task details',
        'taskDetail.specification.fullRecord': 'Full specification record',
        'taskDetail.specification.noRequirements': 'No requirements are linked to this task.',
        'taskDetail.specification.requirements': 'Requirements',
        'taskDetail.specification.requirementsUnavailable':
          'Requirements were not included in the loaded task data.',
        'taskDetail.specification.status': 'Specification status: {{status}}',
      };
      return (messages[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(values?.[name] ?? '')
      );
    },
  }),
}));

import { SpecificationTaskDetails } from './SpecificationTaskDetails';

import type { SpecificationTaskIdentity } from '@renderer/utils/specificationTaskPresentation';

const registryTask: SpecificationTaskIdentity = {
  id: 'registry-task-1',
  displayId: 'TASK-12',
  specProject: 'product',
  specSlug: 'editor',
  registryLocalId: 'TASK-12',
  registryStatus: 'blocked',
  requirements: ['FR-1', 'AC-3'],
  registryEntity: {
    canonicalId: 'product/editor/TASK-12',
    kind: 'TASK',
    title: 'Persist editor state',
    body: 'Persist state after every edit.',
    attributes: { priority: 'high' },
    contentHash: 'sha256:abc123',
    span: { path: 'TASKS.md', startLine: 12 },
  },
};

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  act(() => {
    mountedRoots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = '';
});

async function renderDetails(task: SpecificationTaskIdentity): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<SpecificationTaskDetails task={task} />);
  });
  return host;
}

describe('SpecificationTaskDetails', () => {
  it('renders canonical requirements, registry status, and full entity projection', async () => {
    const host = await renderDetails(registryTask);

    expect(host.textContent).toContain('product/editor · TASK-12');
    expect(host.textContent).toContain('Specification status: blocked');
    expect(host.textContent).toContain('FR-1');
    expect(host.textContent).toContain('AC-3');
    expect(host.textContent).toContain('Persist state after every edit.');
    expect(host.textContent).toContain('sha256:abc123');
  });

  it('does not show registry metadata for an unscoped local task', async () => {
    const host = await renderDetails({ id: 'local-task', displayId: 'TASK-12' });

    expect(host.querySelector('[data-testid="specification-task-details"]')).toBeNull();
    expect(host.textContent).toBe('');
  });
});
