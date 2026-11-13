import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: { discoverSpecRegistry: registry.discover } } }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

import { SpecRegistryPicker } from './SpecRegistryPicker';
import { isTeamSpecBindingSelectionValid } from './teamSpecBindingSelection';

let root: Root | undefined;
let container: HTMLDivElement;

const FirstSpecWorkflow = (): React.JSX.Element => {
  const [project, setProject] = useState('');
  const [slug, setSlug] = useState('');
  const [verified, setVerified] = useState<string | null>(null);
  return (
    <>
      <SpecRegistryPicker
        project={project}
        slug={slug}
        onProjectChange={setProject}
        onSlugChange={setSlug}
        onValidSelectionChange={setVerified}
      />
      <output aria-label="selected project">{project}</output>
      <output aria-label="verified registry selection">{verified ?? 'unverified'}</output>
      <button
        type="button"
        disabled={!project || !isTeamSpecBindingSelectionValid(project, slug, verified)}
      >
        Begin first specification
      </button>
    </>
  );
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  registry.discover.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
});

describe('registry project selection before its first specification', () => {
  it('discovers an empty project and authorizes the first-spec workflow without fabricating a slug', async () => {
    registry.discover.mockResolvedValue({
      url: 'https://registry.unit.invalid/mcp',
      projects: [{ id: 'owner/new-project', specs: [] }],
    });
    await act(async () => {
      root!.render(<FirstSpecWorkflow />);
      await Promise.resolve();
    });
    expect(container.querySelector('output')?.textContent).toBe('owner/new-project');
    const begin = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Begin first specification'
    );
    expect(begin).toBeDefined();
    expect(begin!.disabled).toBe(false);
  });

  it('does not authorize an unavailable project even when it has no specs', async () => {
    registry.discover.mockResolvedValue({
      url: 'https://registry.unit.invalid/mcp',
      projects: [{ id: 'owner/unavailable', specs: [], unavailable: true }],
    });
    await act(async () => {
      root!.render(<FirstSpecWorkflow />);
      await Promise.resolve();
    });
    expect(container.querySelector('output')?.textContent).toBe('');
    expect(
      container.querySelector('output[aria-label="verified registry selection"]')?.textContent
    ).toBe('unverified');
    const begin = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Begin first specification'
    );
    expect(begin!.disabled).toBe(true);
  });
});
