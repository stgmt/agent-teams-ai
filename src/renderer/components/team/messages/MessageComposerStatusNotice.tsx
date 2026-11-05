import { useAppTranslation } from '@features/localization/renderer';
import { isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { AlertCircle, Check } from 'lucide-react';

import { OpenCodeDeliveryWarning } from './OpenCodeDeliveryWarning';

import type { ComposerPersistenceStatus } from '@renderer/types/composerDraft';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';

interface MessageComposerStatusNoticeProps {
  readonly readError: string | null;
  readonly persistenceStatus: ComposerPersistenceStatus;
  readonly restoredDeliveryUnknown: boolean;
  readonly restrictionReason: string | null;
  readonly submissionError: string | null;
  readonly sendWarning: string | null;
  readonly sendDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
  readonly deduplicated: boolean;
  readonly onRetryStorage?: () => Promise<void>;
  readonly retryingStorage?: boolean;
  readonly storageRetryFailed?: boolean;
}

export const MessageComposerStatusNotice = ({
  readError,
  persistenceStatus,
  restoredDeliveryUnknown,
  restrictionReason,
  submissionError,
  sendWarning,
  sendDebugDetails,
  deduplicated,
  onRetryStorage,
  retryingStorage,
  storageRetryFailed,
}: MessageComposerStatusNoticeProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const alert = (text: string, warning = false): React.JSX.Element => (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${warning ? 'bg-amber-500/10 text-amber-300' : 'bg-red-500/10 text-red-400'}`}
    >
      <AlertCircle size={10} className="shrink-0" />
      {text}
    </span>
  );

  if (sendWarning && isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails(sendDebugDetails)) {
    return <OpenCodeDeliveryWarning warning={sendWarning} debugDetails={sendDebugDetails} />;
  }
  if (submissionError) return alert(submissionError);
  if (restrictionReason) return alert(restrictionReason, true);
  if (persistenceStatus === 'memory-only') {
    return (
      <span role="status" className="inline-flex flex-wrap items-center gap-2">
        {alert(
          t(
            storageRetryFailed
              ? 'messageComposer.status.retryFailed'
              : 'messageComposer.status.memoryOnly'
          ),
          true
        )}
        {onRetryStorage ? (
          <button
            type="button"
            disabled={retryingStorage}
            onClick={() => {
              void onRetryStorage();
            }}
            className="text-xs underline"
          >
            {t('messageComposer.status.retryStorage')}
          </button>
        ) : null}
      </span>
    );
  }
  if (readError) return alert(t('messageComposer.status.storageReadFailed'), true);
  if (restoredDeliveryUnknown) {
    return alert(t('messageComposer.status.previousDeliveryUnknown'), true);
  }
  if (sendWarning) {
    return <OpenCodeDeliveryWarning warning={sendWarning} debugDetails={sendDebugDetails} />;
  }
  if (!deduplicated) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
      <Check size={10} className="shrink-0" />
      {t('messageComposer.status.reusedCrossTeamRequest')}
    </span>
  );
};
