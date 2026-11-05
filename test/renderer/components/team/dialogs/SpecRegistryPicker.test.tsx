import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpecRegistryPicker } from '@renderer/components/team/dialogs/SpecRegistryPicker';
import { SpecRegistryConnectionDialog } from '@renderer/components/team/dialogs/SpecRegistryConnectionDialog';
import { TeamLoadError } from '@renderer/components/team/TeamLoadError';

const { discover, updateConfig } = vi.hoisted(() => ({ discover: vi.fn(), updateConfig: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: { discoverSpecRegistry: discover, updateConfig } } }));
vi.mock('@features/localization/renderer', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { teamByName: Record<string, object> }) => unknown) =>
    selector({ teamByName: { demo: {} } }),
}));
vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: { value: string; onValueChange: (value: string) => void; disabled: boolean; children: React.ReactNode }) => (
    <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder: string }) => <option value="">{placeholder}</option>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, disabled, children }: { value: string; disabled?: boolean; children: React.ReactNode }) => <option value={value} disabled={disabled}>{children}</option>,
}));

const data = (projects: Array<{ id: string; specs: Array<{ slug: string }>; unavailable?: true }>) => ({ url: 'http://registry', projects });
const spec = (slug: string) => ({ slug });

function Harness({ initialProject = '', initialSlug = '' }: { initialProject?: string; initialSlug?: string }) {
  const [project, setProject] = useState(initialProject);
  const [slug, setSlug] = useState(initialSlug);
  const [valid, setValid] = useState<string | null>(null);
  return <><SpecRegistryPicker project={project} slug={slug} onProjectChange={setProject} onSlugChange={setSlug} onValidSelectionChange={setValid} /><output>{JSON.stringify({ project, slug, valid })}</output></>;
}

async function mount(element: React.ReactElement) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); await Promise.resolve(); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
}

afterEach(() => { discover.mockReset(); updateConfig.mockReset(); document.body.innerHTML = ''; });

describe('SpecRegistryPicker', () => {
  it.each([
    ['MISSING_TOKEN', 'missingToken'],
    ['UNAUTHORIZED', 'unauthorized'],
    ['INVALID_URL', 'invalidUrl'],
    ['INVALID_RESPONSE', 'invalidResponse'],
    ['TIMEOUT', 'error'],
  ])('shows actionable status for %s without exposing error details', async (code, message) => {
    discover.mockRejectedValueOnce(new Error(`${code}: private details`));
    const { host, unmount } = await mount(<Harness />);
    expect(host.textContent).toContain(`create.registryPicker.${message}`);
    expect(host.textContent).not.toContain('private details');
    expect(JSON.parse(host.querySelector('output')!.textContent!).valid).toBeNull();
    await unmount();
  });

  it('retries a failed discovery and selects only the unambiguous binding', async () => {
    discover.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(data([{ id: 'one', specs: [spec('alpha')] }]));
    const { host, unmount } = await mount(<Harness />);
    expect(host.textContent).toContain('create.registryPicker.error');
    expect(host.querySelector('output')?.textContent).toContain('"valid":null');
    await act(async () => { host.querySelector('button')?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('create.registryPicker.connected');
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({ project: 'one', slug: 'alpha', valid: '["one","alpha"]' });
    await unmount();
  });

  it('preserves saved choices, clears the old spec on project change and requires a real choice', async () => {
    discover.mockResolvedValue(data([{ id: 'one', specs: [spec('alpha')] }, { id: 'two', specs: [spec('beta'), spec('gamma')] }]));
    const { host, unmount } = await mount(<Harness initialProject="one" initialSlug="alpha" />);
    expect(JSON.parse(host.querySelector('output')!.textContent!).valid).toBe('["one","alpha"]');
    const selects = host.querySelectorAll('select');
    await choose(selects[0], 'two');
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({ project: 'two', slug: '', valid: null });
    await choose(selects[1], 'gamma');
    expect(JSON.parse(host.querySelector('output')!.textContent!).valid).toBe('["two","gamma"]');
    await unmount();
    const reopened = await mount(<Harness initialProject="two" initialSlug="gamma" />);
    expect(JSON.parse(reopened.host.querySelector('output')!.textContent!).valid).toBe('["two","gamma"]');
    await reopened.unmount();
  });

  it('allows selection of reachable projects without treating unavailable projects as empty', async () => {
    discover.mockResolvedValue(data([
      { id: 'owner/unavailable', specs: [], unavailable: true },
      { id: 'owner/available', specs: [spec('alpha')] },
    ]));
    const current = await mount(<Harness />);
    expect(JSON.parse(current.host.querySelector('output')!.textContent!)).toEqual({
      project: 'owner/available', slug: 'alpha', valid: '["owner/available","alpha"]',
    });
    expect((current.host.querySelector('option[value="owner/unavailable"]') as HTMLOptionElement).disabled).toBe(true);
    await current.unmount();

    const saved = await mount(<Harness initialProject="owner/unavailable" initialSlug="old" />);
    expect(JSON.parse(saved.host.querySelector('output')!.textContent!)).toEqual({
      project: 'owner/unavailable', slug: 'old', valid: null,
    });
    expect(saved.host.querySelector('[role="alert"]')).not.toBeNull();
    await saved.unmount();
  });

  it('reports empty and missing saved selections without replacing them', async () => {
    discover.mockResolvedValueOnce(data([])).mockResolvedValueOnce(data([{ id: 'other', specs: [] }]));
    const { host, unmount } = await mount(<Harness initialProject="saved" initialSlug="old" />);
    expect(host.textContent).toContain('create.registryPicker.noProjects');
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual({ project: 'saved', slug: 'old', valid: null });
    await act(async () => { host.querySelector('button')?.click(); await Promise.resolve(); });
    expect(host.textContent).toContain('create.registryPicker.missingProject');
    expect(JSON.parse(host.querySelector('output')!.textContent!).project).toBe('saved');
    await choose(host.querySelector('select')!, 'other');
    expect(host.textContent).toContain('create.registryPicker.noSpecs');
    await unmount();
  });

  it('ignores discovery results from an unmounted picker', async () => {
    let finishDiscovery!: (value: { url: string; projects: Array<{ id: string; specs: Array<{ slug: string }> }> }) => void;
    const pending = new Promise<{ url: string; projects: Array<{ id: string; specs: Array<{ slug: string }> }> }>((resolve) => { finishDiscovery = resolve; });
    discover.mockReturnValueOnce(pending).mockResolvedValueOnce(data([{ id: 'new', specs: [spec('current')] }]));
    const old = await mount(<Harness />);
    await old.unmount();
    const current = await mount(<Harness />);
    await act(async () => { finishDiscovery(data([{ id: 'old', specs: [spec('stale')] }])); await Promise.resolve(); });
    expect(JSON.parse(current.host.querySelector('output')!.textContent!).project).toBe('new');
    await current.unmount();
  });
});

describe('SpecRegistryConnectionDialog', () => {
  it('connects an existing team to a discovered specification', async () => {
    discover.mockResolvedValue(data([{ id: 'owner/project', specs: [spec('requirements')] }]));
    updateConfig.mockResolvedValue({});
    const onSaved = vi.fn();
    const { host, unmount } = await mount(
      <SpecRegistryConnectionDialog teamName="demo" onClose={vi.fn()} onSaved={onSaved} />
    );
    const connect = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'create.registryPicker.connectAction'
    );
    expect(connect?.disabled).toBe(false);
    await act(async () => { connect?.click(); await Promise.resolve(); });
    expect(updateConfig).toHaveBeenCalledWith('demo', {
      specProject: 'owner/project',
      specSlug: 'requirements',
    });
    expect(onSaved).toHaveBeenCalledOnce();
    await unmount();
  });

  it('lets an unbound team connect from the loading error and retries it', async () => {
    discover.mockResolvedValue(data([{ id: 'owner/project', specs: [spec('requirements')] }]));
    updateConfig.mockResolvedValue({});
    const onRetry = vi.fn();
    const { host, unmount } = await mount(
      <TeamLoadError teamName="demo" error="REGISTRY_SCOPE_INCOMPLETE" onRetry={onRetry} />
    );
    const open = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'create.registryPicker.connectTitle'
    );
    await act(async () => { open?.click(); await Promise.resolve(); });
    const connect = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'create.registryPicker.connectAction'
    );
    await act(async () => { connect?.click(); await Promise.resolve(); });
    expect(updateConfig).toHaveBeenCalledWith('demo', {
      specProject: 'owner/project', specSlug: 'requirements',
    });
    expect(onRetry).toHaveBeenCalledOnce();
    await unmount();
  });
});
