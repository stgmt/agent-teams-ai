import React, { act } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createRoot } from 'react-dom/client';

import { createI18nextInstance } from '@features/localization/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  teams: {
    listTeamSpecBindings: vi.fn(),
    discoverSpecRegistry: vi.fn(),
    linkTeamSpec: vi.fn(),
    unlinkTeamSpec: vi.fn(),
    replaceMembers: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({ api: apiMock }));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type,
    ...props
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    type?: 'button' | 'submit' | 'reset';
    [key: string]: unknown;
  }) =>
    React.createElement(
      'button',
      { ...props, disabled, onClick, type } as React.ButtonHTMLAttributes<HTMLButtonElement>,
      children
    ),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('footer', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('header', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
}));

import { TeamSpecBindingsManager } from './TeamSpecBindingsManager';

import type { SpecificationBinding } from '@renderer/utils/specificationTaskPresentation';

const teamName = 'canvas-team';
const existingBinding: SpecificationBinding = { project: 'test/studio', spec: 'canvas' };
const newBinding: SpecificationBinding = { project: 'test/studio', spec: 'registry-api' };

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(() => {
  act(() => {
    mountedRoots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.teams.listTeamSpecBindings.mockResolvedValue([existingBinding]);
  apiMock.teams.discoverSpecRegistry.mockResolvedValue({
    url: 'http://127.0.0.1:8090',
    projects: [{ id: 'test/studio', specs: [{ slug: 'canvas' }, { slug: 'registry-api' }] }],
  });
  apiMock.teams.linkTeamSpec.mockResolvedValue([existingBinding, newBinding]);
  apiMock.teams.unlinkTeamSpec.mockResolvedValue([]);
});

async function renderManager(
  onBindingsChange: (bindings: SpecificationBinding[] | null) => void,
  bindings: SpecificationBinding[] = [existingBinding]
): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={createI18nextInstance('en')}>
        <TeamSpecBindingsManager
          teamName={teamName}
          scope={{ projects: ['test/studio'], bindings }}
          open
          onOpenChange={() => undefined}
          onBindingsChange={onBindingsChange}
        />
      </I18nextProvider>
    );
    await Promise.resolve();
  });
  return host;
}
async function selectRegistrySpec(host: HTMLElement, label: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Specification to link"]'
  );
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent === label
  );
  expect(option).toBeDefined();
  await act(async () => {
    option!.focus();
    option!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(trigger!.textContent).toContain(label);
}

describe('TeamSpecBindingsManager', () => {
  it('links a newly discovered specification to the team', async () => {
    const onBindingsChange = vi.fn();
    const host = await renderManager(onBindingsChange);
    await selectRegistrySpec(host, 'test/studio/registry-api');
    const linkButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Link specification'
    );
    expect(linkButton).toBeDefined();
    expect(linkButton!.disabled).toBe(false);

    await act(async () => {
      linkButton?.click();
      await Promise.resolve();
    });

    expect(apiMock.teams.linkTeamSpec).toHaveBeenCalledWith(teamName, newBinding);
    expect(onBindingsChange).toHaveBeenLastCalledWith([existingBinding, newBinding]);
  });

  it('links a registry specification to an unbound team without changing its roster', async () => {
    apiMock.teams.listTeamSpecBindings.mockResolvedValue([]);
    apiMock.teams.linkTeamSpec.mockResolvedValue([newBinding]);
    const onBindingsChange = vi.fn();
    const host = await renderManager(onBindingsChange, []);
    await selectRegistrySpec(host, 'test/studio/registry-api');
    const linkButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Link specification'
    );
    expect(linkButton).toBeDefined();
    expect(linkButton!.disabled).toBe(false);

    await act(async () => {
      linkButton?.click();
      await Promise.resolve();
    });

    expect(apiMock.teams.listTeamSpecBindings).toHaveBeenCalledWith(teamName);
    expect(apiMock.teams.linkTeamSpec).toHaveBeenCalledWith(teamName, newBinding);
    expect(apiMock.teams.replaceMembers).not.toHaveBeenCalled();
    expect(onBindingsChange).toHaveBeenLastCalledWith([newBinding]);
  });

  it('shows registry failures instead of treating them as an empty specification list', async () => {
    apiMock.teams.listTeamSpecBindings.mockResolvedValue([]);
    apiMock.teams.discoverSpecRegistry.mockRejectedValue(new Error('registry unavailable'));
    const host = await renderManager(vi.fn());

    expect(host.textContent).toContain('Registry discovery failed: registry unavailable');
    expect(host.textContent).not.toContain('No unlinked specifications were found.');
  });

  it('marks binding state unknown when the binding list cannot be loaded', async () => {
    apiMock.teams.listTeamSpecBindings.mockRejectedValue(new Error('registry unavailable'));
    const states: (SpecificationBinding[] | null)[] = [];
    const host = await renderManager((bindings) => {
      states.push(bindings);
    });

    expect(states.at(-1)).toBeNull();
    expect(host.textContent).toContain(
      'Could not load linked specifications: registry unavailable'
    );
  });
});
