import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';

import type { TaskArtifactRequirement, TaskFieldUpdates } from '@shared/types';

interface Props {
  requirement?: TaskArtifactRequirement;
  canMutate: () => boolean;
  onUpdate: (fields: TaskFieldUpdates) => Promise<void>;
}

export function TaskArtifactSettings({
  requirement,
  canMutate,
  onUpdate,
}: Readonly<Props>): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const [relativePath, setRelativePath] = useState(requirement?.reference?.relativePath ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = async (fields: TaskFieldUpdates): Promise<void> => {
    if (!canMutate()) return;
    setError(null);
    setPending(true);
    try {
      await onUpdate(fields);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifact.failed'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mb-3 space-y-2 rounded-md border border-[var(--color-border)] p-3 text-sm">
      <label className="flex items-center gap-2">
        <Switch
          checked={requirement?.required === true}
          disabled={pending}
          onCheckedChange={(checked) => void update({ artifactRequired: checked })}
        />
        {t('artifact.require')}
      </label>
      {requirement?.required ? (
        <>
          <p className="text-xs text-[var(--color-text-muted)]">{t('artifact.hint')}</p>
          <div className="flex gap-2">
            <Input
              aria-label={t('artifact.path')}
              placeholder={t('artifact.path')}
              value={relativePath}
              onChange={(event) => setRelativePath(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={pending || !relativePath.trim()}
              onClick={() => void update({ artifactProjectPath: relativePath.trim() })}
            >
              {t('artifact.attach')}
            </Button>
          </div>
          {requirement.proof ? (
            <p className="break-all text-xs text-[var(--color-text-muted)]">
              {requirement.reference?.relativePath} · {requirement.proof.size} B · SHA-256{' '}
              {requirement.proof.sha256}
            </p>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">{t('artifact.missing')}</p>
          )}
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
