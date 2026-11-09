import { useEffect, useId, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Label } from '@renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select';
import { registrySelectionKey } from './teamSpecBindingSelection';

import type { SpecRegistryDiscovery } from '@shared/types';
type DiscoveryError = 'missingToken' | 'unauthorized' | 'invalidUrl' | 'invalidResponse' | 'error';
type DiscoveryState =
  | { status: 'loading' }
  | { status: 'error'; message: DiscoveryError }
  | { status: 'ready'; data: SpecRegistryDiscovery };
const EMPTY_PROJECTS: SpecRegistryDiscovery['projects'] = [];

function discoveryErrorKey(error: unknown): DiscoveryError {
  const code = error instanceof Error ? error.message : '';
  if (code.includes('MISSING_TOKEN')) return 'missingToken';
  if (code.includes('UNAUTHORIZED')) return 'unauthorized';
  if (code.includes('INVALID_URL')) return 'invalidUrl';
  if (code.includes('INVALID_RESPONSE')) return 'invalidResponse';
  return 'error';
}

export { registrySelectionKey } from './teamSpecBindingSelection';

interface SpecRegistryPickerProps {
  project: string;
  slug: string;
  onProjectChange: (value: string) => void;
  onSlugChange: (value: string) => void;
  disabled?: boolean;
  allowEmptySelection?: boolean;

  onValidSelectionChange: (key: string | null) => void;
}

export function SpecRegistryPicker({
  project,
  slug,
  onProjectChange,
  onSlugChange,
  onValidSelectionChange,
  disabled = false,
  allowEmptySelection = false,
}: SpecRegistryPickerProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const id = useId();
  const [refresh, setRefresh] = useState(0);
  const requestGeneration = useRef(0);
  const [state, setState] = useState<DiscoveryState>({ status: 'loading' });
  const projects = state.status === 'ready' ? state.data.projects : EMPTY_PROJECTS;
  const selectedProject = projects.find((item) => item.id === project);
  const valid = Boolean(
    !selectedProject?.unavailable && selectedProject?.specs.some((item) => item.slug === slug)
  );

  useEffect(() => {
    let active = true;
    const generation = ++requestGeneration.current;
    setState({ status: 'loading' });
    onValidSelectionChange(null);
    void api.teams.discoverSpecRegistry().then(
      (data) => {
        if (active && requestGeneration.current === generation) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (active && requestGeneration.current === generation)
          setState({ status: 'error', message: discoveryErrorKey(error) });
      }
    );
    return () => {
      active = false;
      onValidSelectionChange(null);
    };
  }, [refresh, onValidSelectionChange]);

  useEffect(() => {
    onValidSelectionChange(valid ? registrySelectionKey(project, slug) : null);
  }, [valid, project, slug, onValidSelectionChange]);

  useEffect(() => {
    if (allowEmptySelection || state.status !== 'ready') return;
    const availableProjects = projects.filter((item) => !item.unavailable);
    if (!project && !slug && availableProjects.length === 1) {
      onProjectChange(availableProjects[0].id);
    } else if (
      project &&
      !slug &&
      selectedProject &&
      !selectedProject.unavailable &&
      selectedProject.specs.length === 1
    ) {
      onSlugChange(selectedProject.specs[0].slug);
    }
  }, [
    allowEmptySelection,
    state,
    project,
    slug,
    projects,
    selectedProject,
    onProjectChange,
    onSlugChange,
  ]);

  const retry = () => {
    requestGeneration.current += 1;
    onValidSelectionChange(null);
    setState({ status: 'loading' });
    setRefresh((value) => value + 1);
  };

  return (
    <div className="space-y-2 md:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {state.status === 'loading'
            ? t('create.registryPicker.loading')
            : state.status === 'error'
              ? t(`create.registryPicker.${state.message}`)
              : t('create.registryPicker.connected', { url: state.data.url })}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={retry}
          disabled={disabled || state.status === 'loading'}
        >
          {state.status === 'error'
            ? t('create.registryPicker.retry')
            : t('create.registryPicker.refresh')}
        </Button>
      </div>
      {state.status === 'ready' && projects.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('create.registryPicker.noProjects')}
        </p>
      )}
      {state.status === 'ready' && projects.some((item) => item.unavailable) && (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t('create.registryPicker.unavailableProjects')}
        </p>
      )}
      {state.status === 'ready' && project && !selectedProject && (
        <p role="alert" className="text-xs text-[var(--field-error-text)]">
          {t('create.registryPicker.missingProject')}
        </p>
      )}
      {selectedProject?.unavailable && (
        <p role="alert" className="text-xs text-[var(--field-error-text)]">
          {t('create.registryPicker.projectUnavailable')}
        </p>
      )}
      {selectedProject && !selectedProject.unavailable && selectedProject.specs.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('create.registryPicker.noSpecs')}
        </p>
      )}
      {selectedProject && !selectedProject.unavailable && slug && !valid && (
        <p role="alert" className="text-xs text-[var(--field-error-text)]">
          {t('create.registryPicker.missingSpec')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-project`}>
            {t(
              allowEmptySelection
                ? 'create.fields.specProjectOptional'
                : 'create.fields.specProject'
            )}
          </Label>
          <Select
            value={project}
            onValueChange={(value) => {
              onValidSelectionChange(null);
              onProjectChange(value);
              onSlugChange('');
            }}
            disabled={
              disabled || state.status !== 'ready' || !projects.some((item) => !item.unavailable)
            }
          >
            <SelectTrigger id={`${id}-project`} className="h-8 text-xs">
              <SelectValue placeholder={t('create.registryPicker.selectProject')} />
            </SelectTrigger>
            <SelectContent>
              {project && !selectedProject && (
                <SelectItem value={project} disabled>
                  {project}
                </SelectItem>
              )}
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id} disabled={item.unavailable}>
                  {item.id}
                  {item.unavailable ? ` (${t('create.registryPicker.unavailableLabel')})` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-spec`}>
            {t(allowEmptySelection ? 'create.fields.specSlugOptional' : 'create.fields.specSlug')}
          </Label>
          <Select
            value={slug}
            onValueChange={(value) => {
              onValidSelectionChange(null);
              onSlugChange(value);
            }}
            disabled={disabled || !selectedProject || selectedProject.specs.length === 0}
          >
            <SelectTrigger id={`${id}-spec`} className="h-8 text-xs">
              <SelectValue placeholder={t('create.registryPicker.selectSpec')} />
            </SelectTrigger>
            <SelectContent>
              {slug && !valid && (
                <SelectItem value={slug} disabled>
                  {slug}
                </SelectItem>
              )}
              {selectedProject?.specs.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
