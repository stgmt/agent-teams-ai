import { useComposerStorageRetry } from '@renderer/hooks/useComposerStorageRetry';

import { MessageComposerStatusNotice } from './MessageComposerStatusNotice';

import type {
  ComposerDraftAddress,
  ComposerPersistenceStatus,
} from '@renderer/types/composerDraft';

export const ComposerStorageNotice = ({
  address,
  flush,
  recover,
  persistenceStatus,
}: {
  address: ComposerDraftAddress;
  flush: () => Promise<void>;
  recover: () => Promise<boolean>;
  persistenceStatus: ComposerPersistenceStatus;
}): React.JSX.Element | null => {
  const retry = useComposerStorageRetry(address, flush, recover);
  if (persistenceStatus !== 'memory-only') return null;
  return (
    <MessageComposerStatusNotice
      readError={null}
      persistenceStatus={persistenceStatus}
      restoredDeliveryUnknown={false}
      restrictionReason={null}
      submissionError={null}
      sendWarning={null}
      sendDebugDetails={null}
      deduplicated={false}
      onRetryStorage={retry.retry}
      retryingStorage={retry.retrying}
      storageRetryFailed={retry.retryError}
    />
  );
};
