import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';

import type { VerifiedAction, VerifiedActionDecision } from '../contracts';

export const VerifiedActionPanel = ({
  contextId,
  teamName,
  taskId,
  enabled,
  canMutate,
}: {
  contextId: string;
  teamName: string;
  taskId: string;
  enabled: boolean;
  canMutate: () => boolean;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [actions, setActions] = useState<VerifiedAction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const bridge = api.verifiedAction;

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      const result = await bridge.list(contextId, teamName, taskId);
      if (generation.current !== requestGeneration) return;
      setActions(result);
      setUncertain(false);
      setError(null);
    } catch {
      if (generation.current !== requestGeneration) return;
      setUncertain(true);
      setError(t('verifiedAction.refreshFailed'));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  }, [bridge, contextId, t, taskId, teamName]);

  useEffect(() => {
    generation.current += 1;
    setActions(null);
    setBusy(false);
    setError(null);
    setUncertain(false);
    if (bridge && contextId === 'local') void refresh();
    return () => {
      generation.current += 1;
    };
  }, [enabled, bridge, contextId, refresh]);

  const mutate = async (operation: () => Promise<VerifiedAction>) => {
    if (!canMutate() || busy || uncertain) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (generation.current !== requestGeneration) return;
      setActions((previous) => [
        ...(previous ?? []).filter((item) => item.id !== result.id),
        result,
      ]);
    } catch {
      if (generation.current !== requestGeneration) return;
      // The IPC response may have been lost after the operation took effect.
      // Only a read is offered; no write is silently retried.
      setUncertain(true);
      setError(t('verifiedAction.resultUnknown'));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  };

  // Keep an existing decision reachable if the requirement was later disabled.
  if (contextId !== 'local' || !bridge || (!enabled && (!actions || actions.length === 0)))
    return null;
  const pending = actions?.some((item) =>
    ['awaiting_approval', 'running', 'question'].includes(item.status)
  );
  const decide = (action: VerifiedAction, decision: VerifiedActionDecision) =>
    void mutate(() => bridge.decide(contextId, action.id, decision));

  return (
    <section
      className="mt-3 rounded-md border border-[var(--color-border)] p-3 text-xs"
      aria-label={t('verifiedAction.title')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{t('verifiedAction.title')}</strong>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
          {t('verifiedAction.refresh')}
        </Button>
      </div>
      <p className="mt-1 text-[var(--color-text-secondary)]">{t('verifiedAction.description')}</p>
      {error ? (
        <p role="alert" className="mt-2 text-red-400">
          {error}
        </p>
      ) : null}
      {actions?.map((action) => (
        <div key={action.id} className="mt-3 border-t border-[var(--color-border)] pt-2">
          <p className="break-all">
            {action.proof.attachmentId} · {action.proof.size} bytes · SHA-256 {action.proof.sha256}
          </p>
          {action.status === 'awaiting_approval' ? (
            <div className="mt-2">
              <p>{t('verifiedAction.approval')}</p>
              <Button
                size="sm"
                className="mt-2"
                disabled={busy || uncertain || !canMutate()}
                onClick={() => void mutate(() => bridge.approve(contextId, action.id))}
              >
                {t('verifiedAction.approve')}
              </Button>
            </div>
          ) : null}
          {action.status === 'question' ? (
            <div className="mt-2" role="group" aria-label={t('verifiedAction.question')}>
              <p>{t('verifiedAction.question')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || uncertain || !canMutate()}
                  onClick={() => decide(action, 'completed')}
                >
                  {t('verifiedAction.completed')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || uncertain || !canMutate()}
                  onClick={() => decide(action, 'retry_once')}
                >
                  {t('verifiedAction.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || uncertain || !canMutate()}
                  onClick={() => decide(action, 'leave_unresolved')}
                >
                  {t('verifiedAction.unresolved')}
                </Button>
              </div>
            </div>
          ) : null}
          {action.status === 'manual' ? <p className="mt-2">{t('verifiedAction.manual')}</p> : null}
          {action.status === 'completed' ? (
            <p className="mt-2">
              {t(
                action.completion === 'user_attested'
                  ? 'verifiedAction.attested'
                  : 'verifiedAction.queued'
              )}
            </p>
          ) : null}
          {action.status === 'running' ? (
            <p className="mt-2">{t('verifiedAction.running')}</p>
          ) : null}
        </div>
      ))}
      {enabled && actions && !pending ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={busy || uncertain || !canMutate()}
          onClick={() => void mutate(() => bridge.prepare(contextId, teamName, taskId))}
        >
          {t('verifiedAction.prepare')}
        </Button>
      ) : null}
    </section>
  );
};
