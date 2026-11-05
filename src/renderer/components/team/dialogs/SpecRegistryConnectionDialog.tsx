import { useState } from 'react';

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

import { registrySelectionKey, SpecRegistryPicker } from './SpecRegistryPicker';

interface SpecRegistryConnectionDialogProps {
  teamName: string;
  initialProject?: string;
  initialSpec?: string;
  onClose(): void;
  onSaved(): void;
}

/** Connect an existing team even when its task board cannot be loaded yet. */
export function SpecRegistryConnectionDialog({
  teamName,
  initialProject = '',
  initialSpec = '',
  onClose,
  onSaved,
}: SpecRegistryConnectionDialogProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [project, setProject] = useState(initialProject);
  const [spec, setSpec] = useState(initialSpec);
  const [validSelection, setValidSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'saveError' | 'bindingImmutable' | null>(null);

  const save = async (): Promise<void> => {
    if (saving || validSelection !== registrySelectionKey(project, spec)) return;
    setSaving(true);
    setError(null);
    try {
      await api.teams.updateConfig(teamName, { specProject: project, specSlug: spec });
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.includes('SPEC_BINDING_IMMUTABLE')
          ? 'bindingImmutable'
          : 'saveError'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent closeDisabled={saving}>
        <DialogHeader>
          <DialogTitle>{t('create.registryPicker.connectTitle')}</DialogTitle>
          <DialogDescription>{t('create.registryPicker.connectDescription')}</DialogDescription>
        </DialogHeader>
        <SpecRegistryPicker
          project={project}
          slug={spec}
          onProjectChange={setProject}
          onSlugChange={setSpec}
          onValidSelectionChange={setValidSelection}
          disabled={saving}
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          {t('create.registryPicker.legacyNotice')}
        </p>
        {error ? (
          <p role="alert" className="text-xs text-[var(--field-error-text)]">
            {t(`create.registryPicker.${error}`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('detail.actions.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={saving || validSelection !== registrySelectionKey(project, spec)}
          >
            {t('create.registryPicker.connectAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
