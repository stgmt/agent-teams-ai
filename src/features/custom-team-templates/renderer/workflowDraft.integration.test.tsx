import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { applyCustomTeamTemplate } from '@features/custom-team-templates/renderer/templateDraft';
import { buildInitialRosterMemberDrafts } from '@renderer/components/team/dialogs/createTeamInitialRoster';
import { MemberDraftRow } from '@renderer/components/team/members/MemberDraftRow';
import { buildMembersFromDrafts } from '@renderer/components/team/members/membersEditorUtils';
import { expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

vi.mock('@features/runtime-provider-management/renderer', () => ({
  OpenCodeLocalModelLimitsCard: () => React.createElement('div', null, 'local-model-limits-card'),
  ProviderBrandIcon: ({ provider }: { provider: { providerId: string } }) =>
    React.createElement('span', {
      'data-testid': 'model-source-logo',
      'data-provider-id': provider.providerId,
    }),
}));

vi.mock('@features/gateway-provider/renderer', () => ({
  GatewayProvidersSettingsSection: () =>
    React.createElement('div', null, 'gateway-providers-settings'),
  MemberGatewaySelector: () =>
    React.createElement(
      'div',
      { 'data-testid': 'member-gateway-selector' },
      'member-gateway-selector'
    ),
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: () => React.createElement('span', { 'data-testid': 'provider-logo' }),
}));

vi.mock('@renderer/components/team/dialogs/EffortLevelSelector', () => ({
  EffortLevelSelector: ({ value }: { value: string }) =>
    React.createElement('div', null, `effort-selector:${value}`),
}));

vi.mock('@renderer/components/team/dialogs/TeamModelSelector', () => ({
  formatTeamModelSummary: (providerId: string, model: string, effort?: string) =>
    [providerId, model || 'Default', effort].filter(Boolean).join(' · '),
  getProviderScopedTeamModelLabel: (_providerId: string, model: string) => model || 'Default',
  getTeamEffortLabel: (effort: string) => effort || 'Default',
  getTeamProviderLabel: (providerId: string) => providerId,
  TeamModelSelector: () => React.createElement('div', null, 'team-model-selector'),
}));

vi.mock('@renderer/components/team/RoleSelect', () => ({
  RoleSelect: ({ value }: { value: string }) => React.createElement('div', null, value),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    title,
    'aria-describedby': ariaDescribedBy,
    'aria-expanded': ariaExpanded,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    title?: string;
    'aria-describedby'?: string;
    'aria-expanded'?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        className,
        onClick,
        disabled,
        title,
        'aria-describedby': ariaDescribedBy,
        'aria-expanded': ariaExpanded,
        'aria-label': ariaLabel,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (value: boolean) => void;
  }) =>
    React.createElement('input', {
      ...props,
      checked,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { value?: string }) =>
    React.createElement('input', { ...props, value, onChange, type: 'text' }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({
    children,
    ...props
  }: React.LabelHTMLAttributes<HTMLLabelElement> & { children: React.ReactNode }) =>
    React.createElement('label', props, children),
}));

vi.mock('@renderer/components/ui/MentionableTextarea', () => ({
  MentionableTextarea: () => React.createElement('textarea'),
}));

vi.mock('@renderer/hooks/useFileListCacheWarmer', () => ({
  useFileListCacheWarmer: () => undefined,
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

const openCodeStatus = vi.hoisted(() => ({ current: null as unknown }));
const runtimeDefaultStatus = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@renderer/hooks/useEffectiveCliProviderStatus', () => ({
  useEffectiveCliProviderStatus: (providerId: string | undefined) => ({
    providerStatus:
      providerId === 'opencode'
        ? openCodeStatus.current
        : providerId
          ? runtimeDefaultStatus.current
          : null,
  }),
}));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async (key: string) =>
      key === 'createTeam:workflow:alice' ? 'OLD instruction from previous draft' : null
    ),
    saveDraft: vi.fn(async () => undefined),
    deleteDraft: vi.fn(async () => undefined),
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
it.each([
  ['empty custom workflow', true, undefined, undefined],
  ['explicit custom workflow', true, 'Intended template workflow', 'Intended template workflow'],
  ['ordinary draft', false, undefined, 'OLD instruction from previous draft'],
])('handles %s with the real member editor', async (_name, custom, workflow, expected) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let members: MemberDraft[] = [];
  const template: CustomTeamTemplateV1 = {
    templateId: 'test-only',
    name: 'Custom',
    schemaVersion: 1,
    teamPrompt: '',
    members: [{ name: 'alice', ...(workflow ? { workflow } : {}) }],
  };
  const copiedMembers = custom ? applyCustomTeamTemplate(template).members : [{ name: 'alice' }];
  const Probe = () => {
    const [items, setItems] = React.useState(() =>
      buildInitialRosterMemberDrafts({ copiedMembers, multimodelEnabled: true })
    );
    members = items;
    const member = items[0];
    return (
      <MemberDraftRow
        member={member}
        index={0}
        nameError={null}
        draftKeyPrefix="createTeam"
        showWorkflow
        onWorkflowChange={(id, value) =>
          setItems((curr) => curr.map((x) => (x.id === id ? { ...x, workflow: value } : x)))
        }
        onNameChange={() => {}}
        onRoleChange={() => {}}
        onCustomRoleChange={() => {}}
        onRemove={() => {}}
        onProviderChange={() => {}}
        onModelChange={() => {}}
        onEffortChange={() => {}}
      />
    );
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  const payload = buildMembersFromDrafts(members);
  expect(payload[0].workflow).toBe(expected);
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
