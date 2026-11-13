import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { SPEC_REGISTRY_NOT_CONFIGURED_CODE } from '@shared/constants/specRegistry';

import { isTeamSpecBindingSelectionValid } from './teamSpecBindingSelection';

import type { TeamCreateRequest } from '@shared/types';

/** Main refuses a launch whose stored registry credential is missing or unusable. */
export function isSpecRegistryNotConfiguredRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.trim() === SPEC_REGISTRY_NOT_CONFIGURED_CODE;
}

interface CreateTeamIntegrationOptions {
  open: boolean;
  project: string;
  slug: string;
  setProject: (value: string) => void;
  setSlug: (value: string) => void;
  initialScope: TeamCreateRequest['specScope'];
}

export interface CreateTeamIntegrationState {
  project: string;
  slug: string;
  revision: number;
  setupOpen: boolean;
  setSetupOpen: (open: boolean) => void;
  requestFields: Pick<TeamCreateRequest, 'specScope' | 'specProject' | 'specSlug'>;
  restoreScope: (scope: TeamCreateRequest['specScope']) => void;
  selectionReady: boolean;
  hasBinding: boolean;
  onProjectChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  onValidSelectionChange: (key: string | null) => void;
  clearBinding: () => void;
  onSetupSaved: () => void;
}

/**
 * A stale stored credential only fails when main checks it, so the refusal must
 * open the same setup offer the pre-submit gate uses instead of surfacing a raw
 * error code. Returns the message the dialog presents.
 */
export function useSpecRegistryRefusalPresentation(
  activeError: string | null,
  integration: Pick<CreateTeamIntegrationState, 'setSetupOpen'>
): string | null {
  const { t } = useAppTranslation('team');
  const setupRequired = isSpecRegistryNotConfiguredRefusal(activeError);
  const { setSetupOpen } = integration;
  useEffect(() => {
    if (setupRequired) setSetupOpen(true);
  }, [setupRequired, setSetupOpen]);
  return setupRequired ? t('create.validation.registryBindingIncomplete') : activeError;
}

/** Owns transient registry setup state; project/slug remain in the persisted create draft. */
export function useCreateTeamIntegrationState({
  open,
  project,
  slug,
  setProject,
  setSlug,
  initialScope,
}: CreateTeamIntegrationOptions): CreateTeamIntegrationState {
  const [validSelection, setValidSelection] = useState<string | null>(null);
  const [copiedScope, setCopiedScope] = useState(initialScope);
  const [setupOpen, setSetupOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfigured(false);
    void api.teams.getSpecRegistryCredentialStatus().then(
      (status) => {
        if (!cancelled) setConfigured(status.configured);
      },
      () => {
        if (!cancelled) setConfigured(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, revision]);

  const restoreScope = useCallback(
    (scope: TeamCreateRequest['specScope']) => {
      const primaryBinding = scope?.bindings[0];
      setCopiedScope(scope);
      setProject(primaryBinding?.project ?? scope?.projects[0] ?? '');
      setSlug(primaryBinding?.spec ?? '');
    },
    [setProject, setSlug]
  );
  const requestFields = useMemo(
    () =>
      copiedScope
        ? { specScope: copiedScope }
        : project.trim()
          ? { specProject: project.trim(), ...(slug.trim() ? { specSlug: slug.trim() } : {}) }
          : {},
    [copiedScope, project, slug]
  );

  return {
    project,
    slug,
    revision,
    setupOpen,
    setSetupOpen,
    requestFields,
    restoreScope,
    selectionReady:
      configured &&
      Boolean(project.trim()) &&
      isTeamSpecBindingSelectionValid(project, slug, validSelection),
    hasBinding: Boolean(slug || copiedScope?.bindings.length),
    onProjectChange: (value: string) => {
      setCopiedScope(undefined);
      setProject(value);
    },
    onSlugChange: (value: string) => {
      setCopiedScope(undefined);
      setSlug(value);
    },
    onValidSelectionChange: setValidSelection,
    clearBinding: () => {
      setCopiedScope(undefined);
      setSlug('');
      setValidSelection(null);
    },
    onSetupSaved: () => {
      setSetupOpen(false);
      setConfigured(false);
      setValidSelection(null);
      setRevision((value) => value + 1);
    },
  };
}
