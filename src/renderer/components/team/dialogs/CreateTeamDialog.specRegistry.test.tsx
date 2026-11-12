import 'fake-indexeddb/auto';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationStructurePayload } from '@features/organizations/contracts';

/** React tracks the node value, so a plain assignment would be ignored. */
function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Provider preparation, filesystem checks and draft persistence are independent
// of registry onboarding. Keep them inert while exercising the real create UI,
// its real registry picker and its real connection dialog.
const fixture = vi.hoisted(() => ({
  status: vi.fn(),
  discover: vi.fn(),
  save: vi.fn(),
  createConfig: vi.fn(),
  onCreate: vi.fn(),
  noop: vi.fn(),
  translate: (key: string) => key,
  members: [],
  providers: new Map(),
  boundNames: new Set(),
  organizationStructure: {
    organizations: [],
    activeOrganizationId: '',
    units: [],
    relations: [],
    availableTeams: [],
    source: 'configured',
  } satisfies OrganizationStructurePayload,
  state: {
    appConfig: { general: { multimodelEnabled: false }, providerConnections: { anthropic: {} } },
    cliStatus: null,
    cliStatusLoading: false,
    cliProviderStatusLoading: {},
  },
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getSpecRegistryCredentialStatus: fixture.status,
      discoverSpecRegistry: fixture.discover,
      saveSpecRegistryCredential: fixture.save,
      createConfig: fixture.createConfig,
    },
    organizations: { getOrganizationStructure: async () => fixture.organizationStructure },
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: fixture.translate }),
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (state: unknown) => unknown) => selector(fixture.state), {
    getState: () => fixture.state,
  }),
}));
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ isLight: false }) }));
vi.mock('@renderer/hooks/useCreateTeamDraft', async () => {
  const { useState } = await import('react');
  return {
    useCreateTeamDraft: () => {
      const [teamName, setTeamName] = useState('');
      const [specProject, setSpecProject] = useState('');
      const [specSlug, setSpecSlug] = useState('');
      const [launchTeam, setLaunchTeam] = useState(true);
      return {
        runtimeSelectionVersion: 1,
        runtimeProviderId: undefined,
        runtimeModel: '',
        teamName,
        specProject,
        specSlug,
        members: fixture.members,
        syncModelsWithLead: true,
        teammateWorktreeDefault: false,
        cwdMode: 'custom',
        selectedProjectPath: '',
        customCwd: '',
        soloTeam: true,
        launchTeam,
        teamColor: 'blue',
        limitContext: false,
        skipPermissions: false,
        selectedEffort: '',
        selectedFastMode: 'off',
        organizationPlacementEnabled: false,
        organizationPlacementOrganizationId: '',
        organizationPlacementParentId: '',
        isLoaded: true,
        restoredFromStorage: false,
        setRuntimeSelection: fixture.noop,
        setTeamName,
        setSpecProject,
        setSpecSlug,
        setMembers: fixture.noop,
        setSyncModelsWithLead: fixture.noop,
        setTeammateWorktreeDefault: fixture.noop,
        setCwdMode: fixture.noop,
        setSelectedProjectPath: fixture.noop,
        setCustomCwd: fixture.noop,
        setSoloTeam: fixture.noop,
        setLaunchTeam,
        setTeamColor: fixture.noop,
        setLimitContext: fixture.noop,
        setSkipPermissions: fixture.noop,
        setSelectedEffort: fixture.noop,
        setSelectedFastMode: fixture.noop,
        setOrganizationPlacementEnabled: fixture.noop,
        setOrganizationPlacementOrganizationId: fixture.noop,
        setOrganizationPlacementParentId: fixture.noop,
        clearDraft: fixture.noop,
      };
    },
  };
});
vi.mock('@renderer/hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    value: '',
    isLoaded: true,
    isSaved: false,
    setValue: fixture.noop,
    clearDraft: fixture.noop,
  }),
}));
vi.mock('@renderer/hooks/useChipDraftPersistence', () => ({
  useChipDraftPersistence: () => ({
    chips: [],
    clearChipDraft: fixture.noop,
    addChip: fixture.noop,
    removeChip: fixture.noop,
  }),
}));
vi.mock('@renderer/hooks/useTaskSuggestions', () => ({
  useTaskSuggestions: () => ({ suggestions: [] }),
}));
vi.mock('@renderer/hooks/useTeamSuggestions', () => ({
  useTeamSuggestions: () => ({ suggestions: [] }),
}));
vi.mock('@renderer/hooks/useProviderReadinessRevalidation', () => ({
  useProviderReadinessRevalidation: () => undefined,
}));
vi.mock('@features/codex-account/renderer', async (importOriginal) => ({
  ...(await importOriginal()),
  useCodexAccountSnapshot: () => ({ snapshot: null, loading: false, error: null }),
}));
vi.mock('@features/workspace-trust/renderer', () => ({
  useWorkspaceTrustStatus: () => ({ status: null, loading: false, error: null }),
  WorkspaceTrustLaunchNotice: () => null,
}));
vi.mock('./useCreateTeamTemplateSelection', () => ({
  useCreateTeamTemplateSelection: () => ({
    templateSelectionDraft: { value: '', isLoaded: true, setValue: fixture.noop },
    storedTemplateSelection: { value: '' },
    appliedTemplateSource: 'none',
    setAppliedTemplateSource: fixture.noop,
    clearTemplateSelection: fixture.noop,
  }),
}));
vi.mock('./projectPathProjects', () => ({ loadProjectPathProjects: async () => [] }));
vi.mock('./useDialogMemberModelScope', () => ({
  useDialogMemberModelScope: () => ({
    scope: {},
    gatewayBindings: {
      pending: false,
      error: null,
      boundMemberNames: fixture.boundNames,
      releaseRetained: fixture.noop,
      run: (action: () => unknown) => action(),
    },
  }),
}));
vi.mock('./useProjectScopedRuntimeProviderStatuses', () => ({
  useProjectScopedRuntimeProviderStatuses: () => ({
    projectScopedCliStatus: null,
    projectScopedOpenCodeStatus: null,
    runtimeProviderStatusById: fixture.providers,
  }),
}));
vi.mock('./useOpenCodeProviderScopedModelAuthority', () => ({
  useOpenCodeProviderScopedDialogModelState: () => ({
    effectiveMemberDrafts: fixture.members,
    effectiveSelectedModel: '',
    openCodeDefaultSelectionError: null,
    handleOpenCodeProviderScopedStatusChange: fixture.noop,
    openCodeCatalogLoaderConfiguration: [],
    openCodePreparationEvidence: new Map(),
    openCodeProviderScopedStatusBySourceId: fixture.providers,
  }),
}));
vi.mock('./useCustomProjectFolder', () => ({
  useCustomProjectFolder: () => ({
    blocksSubmit: false,
    status: 'unknown',
    checking: false,
  }),
}));
vi.mock('./useMemberWorkspaceInfo', () => ({ useMemberWorkspaceInfo: () => ({}) }));
vi.mock('./OpenCodeProviderScopedDialogCatalogLoaders', () => ({
  OpenCodeProviderScopedDialogCatalogLoaders: () => null,
}));
vi.mock('./OpenCodeSourceDirectoryProvider', () => ({
  OpenCodeSourceDirectoryProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@features/custom-team-templates/renderer', () => ({
  CreateTeamTemplatePicker: () => null,
}));
vi.mock('./CreateTeamPromptField', () => ({ CreateTeamPromptField: () => null }));
vi.mock('./AdvancedCliSection', () => ({ AdvancedCliSection: () => null }));
vi.mock('./ProjectPathSelector', () => ({ ProjectPathSelector: () => null }));
vi.mock('./ProvisioningProviderRuntimeSettingsDialog', () => ({
  ProvisioningProviderRuntimeSettingsDialog: () => null,
}));

import { CreateTeamDialog } from './CreateTeamDialog';

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  fixture.status.mockReset().mockResolvedValue({ configured: false, url: null, source: 'none' });
  fixture.discover.mockReset().mockRejectedValue(new Error('MISSING_TOKEN'));
  fixture.save.mockReset();
  fixture.createConfig.mockReset().mockResolvedValue(undefined);
  fixture.onCreate.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
});

vi.mock('@renderer/components/team/members/TeamRosterEditorSection', () => ({
  TeamRosterEditorSection: () => null,
}));
vi.mock('./RetryOpenCodeStatus', () => ({ CreateTeamProviderStatusStrip: () => null }));
vi.mock('./teammateRuntimeCompatibility', async (importOriginal) => ({
  ...(await importOriginal()),
  useTmuxRuntimeReadiness: () => ({
    status: null,
    loading: false,
    error: null,
    refresh: fixture.noop,
  }),
}));

describe('CreateTeamDialog first-user registry setup', () => {
  it('offers credential setup in the new-team flow before any team is launched', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <CreateTeamDialog
          open
          presentation="page"
          canCreate
          provisioningErrorsByTeam={{}}
          existingTeamNames={[]}
          onClose={fixture.noop}
          onCreate={fixture.onCreate}
          onOpenTeam={fixture.noop}
        />
      );
      await Promise.resolve();
    });
    // Existing translated connection action, not a new test-only component.
    const setup = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'create.registryPicker.connectAction'
    );
    expect(setup, 'new users must be offered setup without first creating a team').toBeDefined();
    expect(setup!.disabled).toBe(false);
    await act(async () => {
      setup!.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector('input[aria-label="create.registryPicker.credentialEndpoint"]')
    ).not.toBeNull();
    expect(
      document.querySelector(
        'input[type="password"][aria-label="create.registryPicker.credentialToken"]'
      )
    ).not.toBeNull();
    expect(fixture.onCreate).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('turns a not-configured launch refusal into the existing setup offer', async () => {
    // Stale stored credential: the app believed Spec Kit was configured, main
    // refused the launch and stored that refusal as the team's provisioning
    // error. The dialog must answer with the setup step, never the raw code.
    fixture.status.mockResolvedValue({
      configured: true,
      url: 'https://registry.unit.invalid/mcp',
      source: 'store',
    });
    fixture.discover.mockResolvedValue({
      url: 'https://registry.unit.invalid/mcp',
      projects: [{ id: 'owner/project', specs: [] }],
    });
    fixture.save.mockResolvedValue({
      ok: true,
      url: 'https://registry.unit.invalid/mcp',
      toolCount: 1,
      errorCode: null,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <CreateTeamDialog
          open
          presentation="page"
          canCreate
          initialData={{
            teamName: 'stale-registry',
            runtimeSelectionVersion: 1,
            members: [],
            specScope: { projects: ['owner/project'], bindings: [] },
          }}
          provisioningErrorsByTeam={{ 'stale-registry': 'SPEC_REGISTRY_NOT_CONFIGURED' }}
          existingTeamNames={[]}
          onClose={fixture.noop}
          onCreate={fixture.onCreate}
          onOpenTeam={fixture.noop}
        />
      );
      await Promise.resolve();
    });
    const findButton = (label: string) =>
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label
      );
    expect(document.body.textContent).not.toContain('SPEC_REGISTRY_NOT_CONFIGURED');
    const presentedError = Array.from(document.querySelectorAll('p')).find(
      (node) => node.textContent?.trim() === 'create.validation.registryBindingIncomplete'
    );
    expect(presentedError, 'the refusal must become the actionable setup step').toBeDefined();
    // The same setup offer the pre-submit gate uses, opened by the refusal itself.
    const endpoint = document.querySelector<HTMLInputElement>(
      'input[aria-label="create.registryPicker.credentialEndpoint"]'
    );
    const token = document.querySelector<HTMLInputElement>(
      'input[type="password"][aria-label="create.registryPicker.credentialToken"]'
    );
    expect(endpoint, 'the setup offer must open itself').not.toBeNull();
    expect(token).not.toBeNull();
    await act(async () => {
      setNativeInputValue(endpoint!, 'https://registry.unit.invalid/mcp');
      setNativeInputValue(token!, 'unit-token');
      await Promise.resolve();
    });
    await act(async () => {
      findButton('create.registryPicker.credentialSave')?.click();
      await Promise.resolve();
    });
    expect(fixture.save).toHaveBeenCalledWith('https://registry.unit.invalid/mcp', 'unit-token');
    // Saving closes the offer, so the same create action stays the retry.
    expect(
      document.querySelector('input[aria-label="create.registryPicker.credentialEndpoint"]')
    ).toBeNull();
    const create = findButton('create.actions.create');
    expect(create, 'the launch must stay reachable after setup').toBeDefined();
    expect(create!.disabled).toBe(false);
  });

  it.each([
    { clearBindings: false, emptyBindings: false },
    { clearBindings: true, emptyBindings: false },
    { clearBindings: false, emptyBindings: true },
  ])(
    'preserves copied scope until explicitly changed (clear=$clearBindings, empty=$emptyBindings)',
    async ({ clearBindings, emptyBindings }) => {
      const scope = {
        projects: ['owner/first', 'owner/second'],
        bindings: emptyBindings
          ? []
          : [
              { project: 'owner/first', spec: 'alpha' },
              { project: 'owner/second', spec: 'beta' },
            ],
      };
      fixture.status.mockResolvedValue({
        configured: true,
        url: 'https://registry.unit.invalid/mcp',
        source: 'store',
      });
      fixture.discover.mockResolvedValue({
        url: 'https://registry.unit.invalid/mcp',
        projects: [
          { id: 'owner/first', specs: [{ slug: 'alpha' }, { slug: 'other' }] },
          { id: 'owner/second', specs: [{ slug: 'beta' }] },
        ],
      });
      const host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <CreateTeamDialog
            open
            presentation="page"
            canCreate
            initialData={{
              teamName: 'scope-copy',
              runtimeSelectionVersion: 1,
              members: [],
              specScope: scope,
            }}
            provisioningErrorsByTeam={{}}
            existingTeamNames={[]}
            onClose={fixture.noop}
            onCreate={fixture.onCreate}
            onOpenTeam={fixture.noop}
          />
        );
        await Promise.resolve();
      });
      if (clearBindings) {
        const clear = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'create.registryPicker.clearBinding'
        );
        expect(clear).toBeDefined();
        await act(async () => {
          clear!.click();
        });
      }
      const create = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'create.actions.create'
      );
      expect(create).toBeDefined();
      expect(create!.disabled).toBe(false);
      await act(async () => {
        create!.click();
      });
      expect(fixture.createConfig).toHaveBeenCalledTimes(1);
      const request = fixture.createConfig.mock.calls[0][0];
      if (clearBindings) {
        expect(request.specScope).toBeUndefined();
        expect(request.specProject).toBe('owner/first');
        expect(request.specSlug).toBeUndefined();
      } else {
        expect(request.specScope).toEqual(scope);
        expect(request.specProject).toBeUndefined();
        expect(request.specSlug).toBeUndefined();
      }
    }
  );
});
