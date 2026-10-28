import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ComposerStorageNotice } from '../../src/renderer/components/team/messages/ComposerStorageNotice';
import { useComposerDraft } from '../../src/renderer/hooks/useComposerDraft';
import { composerDatabase } from '../../src/renderer/services/composerDatabase';
import { composerDraftRepository } from '../../src/renderer/services/composerDraftRepository';

import type { ComposerDraftAddress } from '../../src/renderer/types/composerDraft';

const address: ComposerDraftAddress = {
  contextId: 'TEST-local',
  teamName: 'TEST-composer',
  target: { kind: 'direct', participant: 'alice' },
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const testWindow = window as unknown as { composerStorageTest: Promise<unknown> };
testWindow.composerStorageTest = (async () => {
  // РИСК: имитируется отказ открытия; физическая причина исходного UnknownError не воспроизводится.
  const originalOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = () => {
    throw new DOMException('Internal error.', 'UnknownError');
  };
  let draft!: ReturnType<typeof useComposerDraft>;
  function Probe() {
    draft = useComposerDraft(address);
    return (
      <>
        <textarea aria-label="TEST-draft" value={draft.text} readOnly />
        <span data-saved>{draft.isSaved ? 'Saved' : 'Not saved'}</span>
        <ComposerStorageNotice
          address={address}
          flush={draft.flush}
          recover={async () =>
            (await composerDraftRepository.retryPersistence?.(
              address.contextId,
              address.teamName
            )) === true
          }
          persistenceStatus={draft.persistenceStatus}
        />
      </>
    );
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    act(() => {
      draft.setText('Остаток\tЧто именно не завершено\nИсправить ошибку\tИсполнитель');
      draft.setActionMode('delegate');
    });
    await act(async () => {
      await draft.flush();
    });
    const failed = {
      status: draft.persistenceStatus,
      saved: draft.isSaved,
      warning: document.body.textContent.includes('Not saved to disk'),
      rawError: document.getElementById('root')!.textContent.includes('Internal error.'),
    };
    indexedDB.open = originalOpen;
    await act(async () => {
      document.querySelector('button')!.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    // Typing after retry must use the recovered revision rather than replacing the draft.
    act(() => {
      draft.setText(draft.text + '\nTEST-newer');
    });
    await act(async () => {
      await draft.flush();
    });
    const recovered = { status: draft.persistenceStatus, saved: draft.isSaved, text: draft.text };
    const fresh = await composerDraftRepository.loadWorking(address);
    const { IndexedDbComposerDraftRepository } =
      await import('../../src/renderer/services/composerDraftRepository');
    const reloaded = await new IndexedDbComposerDraftRepository().loadWorking(address);
    return {
      reloadedText: reloaded.working.content?.text,
      failed,
      recovered,
      durableText: fresh.working.content?.text,
      actionMode: fresh.working.content?.actionMode,
    };
  } finally {
    indexedDB.open = originalOpen;
    act(() => root.unmount());
    composerDatabase.close();
  }
})();
