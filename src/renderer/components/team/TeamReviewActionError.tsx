import { useAppTranslation } from '@features/localization/renderer';

export const TeamReviewActionError = ({
  error,
}: {
  error: string | null;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  if (!error) return null;

  const message =
    error.includes('Review transition for task') && error.includes('unknown outcome')
      ? t('artifact.recoveryActionHint')
      : error.includes('A required task artifact has not been attached')
        ? t('artifact.actionMissing')
        : error.includes('Required task artifact cannot be verified')
          ? t('artifact.actionInvalid')
          : error;
  return (
    <div
      role="alert"
      className="mx-4 mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-[var(--step-error-text)]"
    >
      {message}
    </div>
  );
};
