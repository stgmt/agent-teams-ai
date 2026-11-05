import { useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';

import {
  ArtifactWriteNotStartedError,
  ArtifactWriteOutcomeHandledError,
} from '../../core/domain/taskArtifactOutcome';

import type { TaskArtifactRequirement, TaskFieldUpdates } from '@shared/types';

const MAX_FILE_SIZE = 20 * 1024 * 1024;

function isArtifactFilename(value: string): boolean {
  const name = value.trim();
  return (
    Boolean(name) &&
    value.length <= 255 &&
    !/[\\/:]/.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    name !== '.' &&
    name !== '..'
  );
}

interface Props {
  requirement?: TaskArtifactRequirement;
  completed: boolean;
  canMutate: () => boolean;
  onUpdate: (fields: TaskFieldUpdates) => Promise<void>;
  onDownload: (attachmentId: string) => Promise<string | null>;
  outcomeUnknown: boolean;
  outcomeChecked: boolean;
  writeInFlight: boolean;
  guardStatus: 'loading' | 'ready' | 'unavailable';
  guardReason: 'unsupported' | 'unavailable' | null;
  otherOperation: boolean;
  onOutcomeUnknown: () => void;
  onCheckOutcome: () => Promise<void>;
  onConfirmOutcome: () => Promise<void>;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
        reject(new Error('Could not read the selected file'));
      } else {
        resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      }
    };
    reader.readAsDataURL(file);
  });
}

export const TaskArtifactSettings = ({
  requirement,
  completed,
  canMutate,
  onUpdate,
  onDownload,
  outcomeUnknown,
  outcomeChecked,
  writeInFlight,
  guardStatus,
  guardReason,
  otherOperation,
  onOutcomeUnknown,
  onCheckOutcome,
  onConfirmOutcome,
}: Readonly<Props>): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [filename, setFilename] = useState(requirement?.expectedFilename ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const update = async (fields: TaskFieldUpdates): Promise<void> => {
    if (
      outcomeUnknown ||
      writeInFlight ||
      guardStatus !== 'ready' ||
      otherOperation ||
      !canMutate()
    )
      return;
    setError(null);
    if (
      fields.artifactExpectedFilename !== undefined &&
      !isArtifactFilename(fields.artifactExpectedFilename)
    ) {
      setError(t('artifact.invalidName'));
      return;
    }
    setPending(true);
    try {
      await onUpdate(fields);
    } catch (err) {
      if (err instanceof ArtifactWriteNotStartedError) setError(t('artifact.notStarted'));
      else if (!(err instanceof ArtifactWriteOutcomeHandledError)) onOutcomeUnknown();
    } finally {
      setPending(false);
    }
  };

  const attach = async (file?: File): Promise<void> => {
    if (
      !file ||
      outcomeUnknown ||
      writeInFlight ||
      guardStatus !== 'ready' ||
      otherOperation ||
      !canMutate()
    ) {
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setError(null);
    if (file.size > MAX_FILE_SIZE) {
      setError(t('artifact.tooLarge'));
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    if (!isArtifactFilename(file.name)) {
      setError(t('artifact.invalidName'));
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    if (requirement?.expectedFilename && requirement.expectedFilename !== file.name.trim()) {
      setError(t('artifact.nameMismatch', { expected: requirement.expectedFilename }));
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    setPending(true);
    try {
      const base64Data = await readBase64(file);
      if (canMutate()) {
        try {
          await onUpdate({ artifactFile: { filename: file.name, base64Data } });
        } catch (err) {
          if (err instanceof ArtifactWriteNotStartedError) setError(t('artifact.notStarted'));
          else if (!(err instanceof ArtifactWriteOutcomeHandledError)) onOutcomeUnknown();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifact.failed'));
    } finally {
      setPending(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const checkOutcome = async (): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      await onCheckOutcome();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifact.failed'));
    } finally {
      setPending(false);
    }
  };

  const confirmOutcome = async (): Promise<void> => {
    setError(null);
    setPending(true);
    try {
      await onConfirmOutcome();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('artifact.failed'));
    } finally {
      setPending(false);
    }
  };

  const download = async (): Promise<void> => {
    if (!requirement?.proof) return;
    setError(null);
    setPending(true);
    try {
      const data = await onDownload(requirement.proof.attachmentId);
      if (data === null) throw new Error(t('artifact.missing'));
      const blob = await fetch(`data:application/octet-stream;base64,${data}`).then((response) =>
        response.blob()
      );
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = requirement.expectedFilename ?? 'artifact';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
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
          disabled={
            pending ||
            writeInFlight ||
            guardStatus !== 'ready' ||
            otherOperation ||
            outcomeUnknown ||
            (completed && !requirement?.required)
          }
          onCheckedChange={(checked) => void update({ artifactRequired: checked })}
        />
        {t('artifact.require')}
      </label>
      {completed ? (
        <p className="text-xs text-[var(--color-text-muted)]">{t('artifact.reopen')}</p>
      ) : null}
      {writeInFlight ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t('artifact.saving')}
        </p>
      ) : null}
      {guardStatus !== 'ready' ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t(
            guardStatus === 'loading'
              ? 'artifact.guardLoading'
              : guardReason === 'unsupported'
                ? 'artifact.guardUnsupported'
                : 'artifact.guardUnavailable'
          )}
        </p>
      ) : null}
      {otherOperation ? (
        <p role="status" className="text-xs text-[var(--color-text-muted)]">
          {t('artifact.otherOperation')}
        </p>
      ) : null}
      {guardStatus === 'ready' && !otherOperation && outcomeUnknown ? (
        <div role="alert" className="space-y-2 text-xs text-[var(--color-text-muted)]">
          <p>{t(outcomeChecked ? 'artifact.confirmMessage' : 'artifact.unknown')}</p>
          {outcomeChecked ? (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => void confirmOutcome()}
            >
              {t('artifact.confirmOutcome')}
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={pending} onClick={() => void checkOutcome()}>
              {t('artifact.checkOutcome')}
            </Button>
          )}
        </div>
      ) : null}
      {requirement?.required ? (
        <>
          <p className="text-xs text-[var(--color-text-muted)]">{t('artifact.hint')}</p>
          {!requirement.expectedFilename ? (
            <p className="text-xs text-[var(--color-text-muted)]">{t('artifact.anyName')}</p>
          ) : null}
          <div className="flex gap-2">
            <Input
              aria-label={t('artifact.name')}
              placeholder={t('artifact.name')}
              value={filename}
              disabled={
                completed ||
                writeInFlight ||
                guardStatus !== 'ready' ||
                otherOperation ||
                outcomeUnknown
              }
              onChange={(event) => setFilename(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={
                pending ||
                completed ||
                writeInFlight ||
                guardStatus !== 'ready' ||
                otherOperation ||
                outcomeUnknown ||
                !filename.trim()
              }
              onClick={() => void update({ artifactExpectedFilename: filename.trim() })}
            >
              {t('artifact.setName')}
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={(event) => void attach(event.target.files?.[0])}
          />
          <Button
            type="button"
            size="sm"
            disabled={
              pending ||
              completed ||
              writeInFlight ||
              guardStatus !== 'ready' ||
              otherOperation ||
              outcomeUnknown
            }
            onClick={() => fileInput.current?.click()}
          >
            {t('artifact.attach')}
          </Button>
          {requirement.proof ? (
            <>
              <p className="break-all text-xs text-[var(--color-text-muted)]">
                {requirement.expectedFilename} · {requirement.proof.size} B · SHA-256{' '}
                {requirement.proof.sha256}
              </p>
              <Button type="button" size="sm" disabled={pending} onClick={() => void download()}>
                {t('artifact.download')}
              </Button>
            </>
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
};
