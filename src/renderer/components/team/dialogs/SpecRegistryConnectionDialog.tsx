import { useEffect, useState } from 'react';

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
import { Input } from '@renderer/components/ui/input';
import { isLoopbackSpecRegistryEndpoint } from '@shared/utils/specRegistryEndpoint';

import { registrySelectionKey, SpecRegistryPicker } from './SpecRegistryPicker';

import type { AppTranslationApi } from '@features/localization/renderer';
import type { SpecRegistryCredentialStatus, SpecRegistryLocalTokenResult } from '@shared/types';

/** Refusals the user can act on; anything else falls back to the generic message. */
function localTokenRefusalMessage(t: AppTranslationApi['t'], code: string): string {
  switch (code) {
    case 'LOCAL_BOOTSTRAP_NOT_LOOPBACK':
      return t('create.registryPicker.localTokenNotLoopback');
    case 'LOCAL_BOOTSTRAP_FORBIDDEN':
      return t('create.registryPicker.localTokenForbidden');
    case 'LOCAL_BOOTSTRAP_DISABLED':
      return t('create.registryPicker.localTokenDisabled');
    default:
      return t('create.registryPicker.localTokenFailed', { code });
  }
}

interface SpecRegistryConnectionDialogProps {
  teamName?: string;
  initialProject?: string;
  initialSpec?: string;
  onClose(): void;
  onSaved(): void;
}

/** Store the app connection before team creation, or connect an existing team. */
export const SpecRegistryConnectionDialog = ({
  teamName,
  initialProject = '',
  initialSpec = '',
  onClose,
  onSaved,
}: SpecRegistryConnectionDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [project, setProject] = useState(initialProject);
  const [spec, setSpec] = useState(initialSpec);
  const [validSelection, setValidSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<'saveError' | null>(null);
  const [credentialUrl, setCredentialUrl] = useState('');
  const [credentialToken, setCredentialToken] = useState('');
  const [credentialStatus, setCredentialStatus] = useState<SpecRegistryCredentialStatus | null>(
    null
  );
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  // The bootstrap only exists for a registry on this machine, so the action is
  // offered for exactly that endpoint shape and nowhere else.
  const localTokenAvailable = isLoopbackSpecRegistryEndpoint(credentialUrl);

  useEffect(() => {
    let cancelled = false;
    void api.teams
      .getSpecRegistryCredentialStatus()
      .then((status) => {
        if (cancelled) return;
        setCredentialStatus(status);
        if (status.url) setCredentialUrl(status.url);
      })
      .catch(() => {
        if (!cancelled) setCredentialStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const checkCredential = async (override?: { url?: string; token?: string }): Promise<void> => {
    setCredentialBusy(true);
    setCredentialError(null);
    setCredentialNotice(null);
    try {
      const result = await api.teams.testSpecRegistryCredential(
        override?.url ?? (credentialUrl.trim() || undefined),
        override?.token ?? (credentialToken.trim() || undefined)
      );
      if (result.ok) {
        setCredentialNotice(
          t('create.registryPicker.credentialCheckOk', { count: result.toolCount ?? 0 })
        );
      } else {
        setCredentialError(
          t('create.registryPicker.credentialCheckFailed', {
            code: result.errorCode ?? 'UNREACHABLE',
          })
        );
      }
    } catch {
      setCredentialError(t('create.registryPicker.credentialCheckFailed', { code: 'UNREACHABLE' }));
    } finally {
      setCredentialBusy(false);
    }
  };

  /**
   * A registry running on this machine can mint the token itself, so the user
   * does not have to paste one. The obtained token goes into the field and the
   * ordinary check runs on it, so success means exactly what a pasted token's
   * success means.
   */
  const getLocalToken = async (): Promise<void> => {
    setCredentialBusy(true);
    setCredentialError(null);
    setCredentialNotice(null);
    let result: SpecRegistryLocalTokenResult;
    try {
      result = await api.teams.requestSpecRegistryLocalToken(credentialUrl.trim());
    } catch {
      result = { ok: false, code: 'LOCAL_BOOTSTRAP_FAILED' };
    }
    if (!result.ok) {
      setCredentialBusy(false);
      setCredentialError(localTokenRefusalMessage(t, result.code));
      return;
    }
    setCredentialToken(result.token);
    await checkCredential({ url: credentialUrl.trim(), token: result.token });
  };

  const saveCredential = async (): Promise<void> => {
    if (!credentialUrl.trim() || !credentialToken.trim()) {
      setCredentialError(t('create.registryPicker.credentialRequired'));
      return;
    }
    setCredentialBusy(true);
    setCredentialError(null);
    setCredentialNotice(null);
    try {
      const result = await api.teams.saveSpecRegistryCredential(
        credentialUrl.trim(),
        credentialToken.trim()
      );
      if (!result.ok) {
        setCredentialError(
          t('create.registryPicker.credentialCheckFailed', {
            code: result.errorCode ?? 'UNREACHABLE',
          })
        );
        return;
      }
      setCredentialToken('');
      setCredentialStatus(await api.teams.getSpecRegistryCredentialStatus());
      setCredentialNotice(t('create.registryPicker.credentialSaved'));
      setValidSelection(null);
      setDiscoveryRevision((revision) => revision + 1);
      if (!teamName) onSaved();
    } catch {
      setCredentialError(t('create.registryPicker.credentialCheckFailed', { code: 'SAVE_FAILED' }));
    } finally {
      setCredentialBusy(false);
    }
  };

  const disconnectCredential = async (): Promise<void> => {
    setCredentialBusy(true);
    setCredentialError(null);
    try {
      await api.teams.clearSpecRegistryCredential();
      setCredentialStatus(await api.teams.getSpecRegistryCredentialStatus());
      setCredentialNotice(t('create.registryPicker.credentialCleared'));
      setValidSelection(null);
      setDiscoveryRevision((revision) => revision + 1);
      if (!teamName) onSaved();
    } catch {
      setCredentialError(
        t('create.registryPicker.credentialCheckFailed', { code: 'CLEAR_FAILED' })
      );
    } finally {
      setCredentialBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (
      !teamName ||
      saving ||
      credentialBusy ||
      !credentialStatus?.configured ||
      !project.trim() ||
      validSelection !== registrySelectionKey(project, spec)
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await api.teams.linkTeamSpec(teamName, {
        project: project.trim(),
        spec: spec.trim(),
      });
      onSaved();
    } catch {
      setError('saveError');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving && !credentialBusy) onClose();
      }}
    >
      <DialogContent closeDisabled={saving || credentialBusy}>
        <DialogHeader>
          <DialogTitle>
            {t(
              teamName
                ? 'create.registryPicker.connectTitle'
                : 'create.registryPicker.credentialTitle'
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              teamName
                ? 'create.registryPicker.connectDescription'
                : 'create.registryPicker.credentialDescription'
            )}
          </DialogDescription>
        </DialogHeader>
        <section className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
          <h3 className="text-sm font-medium">{t('create.registryPicker.credentialTitle')}</h3>
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('create.registryPicker.credentialDescription')}
          </p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {credentialStatus?.configured
              ? t('create.registryPicker.credentialStored', {
                  url: credentialStatus.url ?? '',
                  source: credentialStatus.source,
                })
              : t('create.registryPicker.credentialMissing')}
          </p>
          <Input
            aria-label={t('create.registryPicker.credentialEndpoint')}
            placeholder={t('create.registryPicker.credentialEndpoint')}
            value={credentialUrl}
            onChange={(event) => setCredentialUrl(event.target.value)}
            disabled={credentialBusy}
          />
          <Input
            aria-label={t('create.registryPicker.credentialToken')}
            placeholder={t('create.registryPicker.credentialToken')}
            type="password"
            autoComplete="off"
            value={credentialToken}
            onChange={(event) => setCredentialToken(event.target.value)}
            disabled={credentialBusy}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('create.registryPicker.credentialHint')}
          </p>
          {localTokenAvailable ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              {t('create.registryPicker.credentialGetTokenHint')}
            </p>
          ) : null}
          {credentialError ? (
            <p role="alert" className="text-xs text-[var(--field-error-text)]">
              {credentialError}
            </p>
          ) : null}
          {credentialNotice ? (
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              {credentialNotice}
            </p>
          ) : null}
          <div className="flex gap-2">
            {localTokenAvailable ? (
              <Button
                variant="outline"
                onClick={() => void getLocalToken()}
                disabled={credentialBusy}
              >
                {t('create.registryPicker.credentialGetToken')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void checkCredential()}
              disabled={credentialBusy}
            >
              {t('create.registryPicker.credentialCheck')}
            </Button>
            <Button onClick={() => void saveCredential()} disabled={credentialBusy}>
              {t('create.registryPicker.credentialSave')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void disconnectCredential()}
              disabled={credentialBusy || !credentialStatus?.configured}
            >
              {t('create.registryPicker.credentialDisconnect')}
            </Button>
          </div>
        </section>
        {teamName && (
          <SpecRegistryPicker
            key={discoveryRevision}
            project={project}
            slug={spec}
            onProjectChange={setProject}
            onSlugChange={setSpec}
            onValidSelectionChange={setValidSelection}
            disabled={saving}
          />
        )}
        {teamName && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('create.registryPicker.legacyNotice')}
          </p>
        )}
        {error ? (
          <p role="alert" className="text-xs text-[var(--field-error-text)]">
            {t(`create.registryPicker.${error}`)}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving || credentialBusy}>
            {t('detail.actions.cancel')}
          </Button>
          {teamName && (
            <Button
              onClick={() => void save()}
              disabled={
                saving ||
                credentialBusy ||
                !credentialStatus?.configured ||
                !project.trim() ||
                validSelection !== registrySelectionKey(project, spec)
              }
            >
              {t('create.registryPicker.connectAction')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
