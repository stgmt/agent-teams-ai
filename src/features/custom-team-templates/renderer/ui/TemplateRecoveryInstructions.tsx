import { useAppTranslation } from '@features/localization/renderer';

/** Shows the server-side paths and manual steps without performing recovery. */
export const TemplateRecoveryInstructions = ({
  storageDirectory,
  markerPath,
}: {
  storageDirectory: string;
  markerPath: string;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="min-w-0 space-y-2">
      <p>{t('customTemplates.library.recoveryRequired')}</p>
      <p>{t('customTemplates.library.recoveryStopAndPreserve')}</p>
      <p>
        {t('customTemplates.library.recoveryStorageDirectory')}{' '}
        <code className="break-all" data-testid="template-recovery-directory">
          {storageDirectory}
        </code>
      </p>
      <p>{t('customTemplates.library.recoveryBackupWarning')}</p>
      <p>{t('customTemplates.library.recoveryMarkerInstructions')}</p>
      <p>
        {t('customTemplates.library.recoveryMarkerPath')}{' '}
        <code className="break-all" data-testid="template-recovery-marker">
          {markerPath}
        </code>
      </p>
    </div>
  );
};
