import { useCallback, useEffect, useRef, useState } from 'react';

import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import { composerDraftAddressKey } from '@renderer/utils/composerDraftIdentity';

import type { ComposerDraftAddress } from '@renderer/types/composerDraft';

async function retryComposerPersistence(contextId: string, teamName: string): Promise<boolean> {
  return (await composerDraftRepository.retryPersistence?.(contextId, teamName)) === true;
}

/** Reconnect and persist only on explicit request; never invokes any message transport. */
export function useComposerStorageRetry(
  address: ComposerDraftAddress,
  flush: () => Promise<void>,
  recover: (contextId: string, teamName: string) => Promise<boolean> = retryComposerPersistence
): {
  retry: () => Promise<void>;
  retrying: boolean;
  retryError: boolean;
} {
  const identity = composerDraftAddressKey(address);
  const owner = useRef(identity);
  owner.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const retry = useCallback(async () => {
    if (active.current || owner.current !== identity) return;
    active.current = true;
    setRetrying(true);
    setFailure(null);
    const isCurrent = (): boolean => mounted.current && owner.current === identity;
    try {
      await flush();
      if (!isCurrent()) return;
      if (!(await recover(address.contextId, address.teamName))) {
        if (isCurrent()) setFailure(identity);
      }
    } catch {
      if (isCurrent()) setFailure(identity);
    } finally {
      active.current = false;
      if (mounted.current) setRetrying(false);
    }
  }, [address, flush, identity, recover]);
  return { retry, retrying, retryError: failure === identity };
}
