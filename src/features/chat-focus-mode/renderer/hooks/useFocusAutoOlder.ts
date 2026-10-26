import { useEffect, useRef, useState } from 'react';

/** Older pages loaded on their own while no request is visible; the user can load more by hand. */
export const FOCUS_AUTO_OLDER_PAGE_CAP = 10;
/** Loads in a row the store skipped (never started) before giving up. */
export const FOCUS_AUTO_OLDER_FAILURE_CAP = 5;
/** A load that has not started by then was skipped by the store (e.g. a head refresh ran). */
export const FOCUS_AUTO_OLDER_START_TIMEOUT_MS = 2_000;

type RequestState = 'idle' | 'requested' | 'loading';

function isExhausted(pages: number, failures: number): boolean {
  return pages >= FOCUS_AUTO_OLDER_PAGE_CAP || failures >= FOCUS_AUTO_OLDER_FAILURE_CAP;
}

/**
 * Busy teams fill the latest page with service traffic, so focus mode loads older pages until
 * the chat shows a request. One page at a time, tracked by the store's loading flag: history
 * growth proves nothing, since live messages keep arriving at the head. A page counts once its
 * load ran, even if none of it belongs to this chat. A load the store skipped (e.g. during a
 * head refresh) or discarded (history changed mid-load) is a failure and is retried a few
 * times. Returns true while it is still searching.
 */
export function useFocusAutoOlder({
  hasRequest,
  hasMore,
  loadingOlder,
  historyDiscarded = false,
  onLoadOlder,
}: {
  hasRequest: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  /** The store dropped the last older page because history changed while it loaded. */
  historyDiscarded?: boolean;
  onLoadOlder?: () => void;
}): boolean {
  const [exhausted, setExhausted] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const onLoadOlderRef = useRef(onLoadOlder);
  const requestRef = useRef<RequestState>('idle');
  const pagesRef = useRef(0);
  const failuresRef = useRef(0);
  const canLoad = !hasRequest && hasMore && Boolean(onLoadOlder);

  useEffect(() => {
    onLoadOlderRef.current = onLoadOlder;
  }, [onLoadOlder]);

  useEffect(() => {
    const settle = (ran: boolean): void => {
      requestRef.current = 'idle';
      if (ran) {
        pagesRef.current += 1;
        failuresRef.current = 0;
      } else {
        failuresRef.current += 1;
      }
      if (isExhausted(pagesRef.current, failuresRef.current)) setExhausted(true);
    };

    if (loadingOlder) {
      if (requestRef.current === 'requested') requestRef.current = 'loading';
      return;
    }
    if (requestRef.current === 'loading') settle(!historyDiscarded);

    if (requestRef.current === 'idle') {
      if (!canLoad || exhausted || isExhausted(pagesRef.current, failuresRef.current)) return;
      requestRef.current = 'requested';
      onLoadOlderRef.current?.();
    }

    // The store may skip the load without ever raising its loading flag.
    const timer = setTimeout(() => {
      if (requestRef.current !== 'requested') return;
      settle(false);
      setRetryTick((tick) => tick + 1);
    }, FOCUS_AUTO_OLDER_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [canLoad, exhausted, historyDiscarded, loadingOlder, retryTick]);

  return canLoad && !exhausted;
}
