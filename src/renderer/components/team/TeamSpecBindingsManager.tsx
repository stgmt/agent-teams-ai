import { useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import {
  formatSpecificationBindingLabel,
  getSpecificationBindingKey,
} from '@renderer/utils/specificationTaskPresentation';

import type { SpecificationBinding } from '@renderer/utils/specificationTaskPresentation';
import type { SpecRegistryDiscovery, TeamSpecScope } from '@shared/types';

interface TeamSpecBindingsManagerProps {
  teamName: string;
  scope: Readonly<TeamSpecScope> | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBindingsChange: (bindings: SpecificationBinding[] | null) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const TeamSpecBindingsManager = ({
  teamName,
  scope,
  open,
  onOpenChange,
  onBindingsChange,
}: TeamSpecBindingsManagerProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [linkedBindings, setLinkedBindings] = useState<SpecificationBinding[]>([
    ...(scope?.bindings ?? []),
  ]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<SpecRegistryDiscovery | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selectedBindingKey, setSelectedBindingKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setLinkedBindings([...(scope?.bindings ?? [])]);
  }, [scope]);

  useEffect(() => {
    if (!open) return;
    onBindingsChange(null);
    let cancelled = false;
    setBindingsLoading(true);
    setBindingsError(null);
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setActionError(null);

    void Promise.allSettled([
      api.teams.listTeamSpecBindings(teamName),
      api.teams.discoverSpecRegistry(),
    ] as const).then(([bindingsResult, discoveryResult]) => {
      if (cancelled) return;
      if (bindingsResult.status === 'fulfilled') {
        setLinkedBindings(bindingsResult.value);
        onBindingsChange(bindingsResult.value);
      } else {
        onBindingsChange(null);
        setBindingsError(errorMessage(bindingsResult.reason));
      }
      if (discoveryResult.status === 'fulfilled') {
        setDiscovery(discoveryResult.value);
      } else {
        setDiscoveryError(errorMessage(discoveryResult.reason));
      }
      setBindingsLoading(false);
      setDiscoveryLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [onBindingsChange, open, teamName]);

  const candidates = useMemo(() => {
    if (!discovery) return [];
    const linkedKeys = new Set(linkedBindings.map(getSpecificationBindingKey));
    return discovery.projects
      .flatMap((project) =>
        project.specs.map((spec) => ({
          project: project.id,
          spec: spec.slug,
          unavailable: project.unavailable === true,
        }))
      )
      .filter((candidate) => !linkedKeys.has(getSpecificationBindingKey(candidate)));
  }, [discovery, linkedBindings]);

  const selectedBinding = candidates.find(
    (binding) => getSpecificationBindingKey(binding) === selectedBindingKey
  );

  const refreshRegistry = async (): Promise<void> => {
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try {
      setDiscovery(await api.teams.discoverSpecRegistry());
      setSelectedBindingKey('');
    } catch (error) {
      setDiscoveryError(errorMessage(error));
    } finally {
      setDiscoveryLoading(false);
    }
  };

  const updateBinding = async (
    operation: 'link' | 'unlink',
    binding: SpecificationBinding
  ): Promise<void> => {
    setSaving(true);
    setActionError(null);
    onBindingsChange(null);
    try {
      const updatedBindings =
        operation === 'link'
          ? await api.teams.linkTeamSpec(teamName, binding)
          : await api.teams.unlinkTeamSpec(teamName, binding);
      setLinkedBindings(updatedBindings);
      onBindingsChange(updatedBindings);
      setSelectedBindingKey('');
    } catch (error) {
      onBindingsChange(null);
      setActionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const unavailableProjects =
    discovery?.projects.filter((project) => project.unavailable === true) ?? [];

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-xs text-[var(--color-text-secondary)]"
        onClick={() => onOpenChange(true)}
        aria-label={t('specificationBindings.buttonAria', { team: teamName })}
      >
        {t('specificationBindings.button', { count: linkedBindings.length })}
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('specificationBindings.title')}</DialogTitle>
            <DialogDescription>{t('specificationBindings.description')}</DialogDescription>
          </DialogHeader>

          <section className="grid gap-2" aria-label={t('specificationBindings.linkedHeading')}>
            <h3 className="text-xs font-semibold text-[var(--color-text)]">
              {t('specificationBindings.linkedHeading')}
            </h3>
            {bindingsLoading ? (
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {t('specificationBindings.loadingBindings')}
              </p>
            ) : null}
            {bindingsError ? (
              <p
                role="alert"
                className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300"
              >
                {t('specificationBindings.bindingsLoadError', { error: bindingsError })}
              </p>
            ) : null}
            {!bindingsLoading && !bindingsError && linkedBindings.length === 0 ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('specificationBindings.emptyBindings')}
              </p>
            ) : null}
            {linkedBindings.length > 0 ? (
              <ul className="grid gap-1.5">
                {linkedBindings.map((binding) => (
                  <li
                    key={getSpecificationBindingKey(binding)}
                    className="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] px-2.5 py-1.5"
                  >
                    <span className="min-w-0 truncate font-mono text-xs text-[var(--color-text)]">
                      {formatSpecificationBindingLabel(binding)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0 px-2 text-xs text-red-300"
                      disabled={saving || bindingsLoading}
                      onClick={() => void updateBinding('unlink', binding)}
                    >
                      {t('specificationBindings.unlink')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            className="grid gap-2 border-t border-[var(--color-border)] pt-3"
            aria-label={t('specificationBindings.availableHeading')}
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold text-[var(--color-text)]">
                {t('specificationBindings.availableHeading')}
              </h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={discoveryLoading}
                onClick={() => void refreshRegistry()}
              >
                {discoveryLoading
                  ? t('specificationBindings.refreshing')
                  : t('specificationBindings.refresh')}
              </Button>
            </div>
            {discoveryLoading && !discovery ? (
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {t('specificationBindings.loadingRegistry')}
              </p>
            ) : null}
            {discoveryError ? (
              <p
                role="alert"
                className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300"
              >
                {t('specificationBindings.discoveryError', { error: discoveryError })}
              </p>
            ) : null}
            {unavailableProjects.length > 0 ? (
              <p role="alert" className="text-xs text-amber-300">
                {t('specificationBindings.unavailableProjects', {
                  projects: unavailableProjects.map((project) => project.id).join(', '),
                })}
              </p>
            ) : null}
            {discovery && candidates.length === 0 && !discoveryError ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('specificationBindings.emptyCandidates')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Select
                value={selectedBindingKey}
                onValueChange={setSelectedBindingKey}
                disabled={
                  !discovery ||
                  discoveryLoading ||
                  discoveryError !== null ||
                  candidates.length === 0 ||
                  saving
                }
              >
                <SelectTrigger aria-label={t('specificationBindings.selectAria')}>
                  <SelectValue placeholder={t('specificationBindings.choose')} />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((binding) => (
                    <SelectItem
                      key={getSpecificationBindingKey(binding)}
                      value={getSpecificationBindingKey(binding)}
                      disabled={binding.unavailable}
                    >
                      {binding.unavailable
                        ? t('specificationBindings.unavailableSuffix', {
                            label: formatSpecificationBindingLabel(binding),
                          })
                        : formatSpecificationBindingLabel(binding)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                className="h-9"
                disabled={
                  discoveryError !== null ||
                  !selectedBinding ||
                  selectedBinding.unavailable ||
                  saving ||
                  bindingsLoading
                }
                onClick={() =>
                  selectedBinding &&
                  void updateBinding('link', {
                    project: selectedBinding.project,
                    spec: selectedBinding.spec,
                  })
                }
              >
                {saving ? t('specificationBindings.saving') : t('specificationBindings.link')}
              </Button>
            </div>
          </section>

          {actionError ? (
            <p
              role="alert"
              className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-300"
            >
              {t('specificationBindings.actionError', { error: actionError })}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('specificationBindings.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
