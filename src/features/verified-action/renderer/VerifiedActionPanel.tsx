import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';

import type { VerifiedAction, VerifiedActionDecision } from '../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';

type TaskGuard = Pick<
  TaskDetailSessionController,
  | 'taskWriteGuard'
  | 'beginGuardedTaskWrite'
  | 'settleGuardedTaskWrite'
  | 'checkGuardedTaskWriteOutcome'
  | 'confirmGuardedTaskWriteOutcome'
>;

function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Verified action outcome timed out')), 30_000);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const VerifiedActionPanel = ({
  contextId,
  teamName,
  taskId,
  enabled,
  canMutate,
  guard,
}: {
  contextId: string;
  teamName: string;
  taskId: string;
  enabled: boolean;
  canMutate: () => boolean;
  guard: TaskGuard;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [actions, setActions] = useState<VerifiedAction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const bridge = api.verifiedAction;
  const guardState = guard.taskWriteGuard;
  const expectedRef = useRef(guardState.expectedContext);
  expectedRef.current = guardState.expectedContext;
  const rootRef = useRef(guardState.expectedRootFingerprint);
  rootRef.current = guardState.expectedRootFingerprint;
  const expectedKey = guardState.expectedContext ? JSON.stringify(guardState.expectedContext) : '';
  const rootKey = guardState.expectedRootFingerprint ?? '';

  const refresh = useCallback(async () => {
    const expected = expectedRef.current;
    const root = rootRef.current;
    if (!bridge || !expected || !expectedKey || !root || !rootKey) return false;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      const result = await bridge.list(contextId, expected, root, teamName, taskId);
      if (generation.current !== requestGeneration) return false;
      setActions(result);
      setUncertain(false);
      setError(null);
      return true;
    } catch {
      if (generation.current !== requestGeneration) return false;
      setUncertain(true);
      setError(t('verifiedAction.refreshFailed'));
      return false;
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  }, [bridge, contextId, expectedKey, rootKey, t, taskId, teamName]);

  useEffect(() => {
    generation.current += 1;
    setActions(null);
    setBusy(false);
    setError(null);
    setUncertain(false);
    if (bridge && contextId === 'local' && expectedKey && rootKey) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [enabled, bridge, contextId, expectedKey, rootKey, refresh]);

  const mutate = async (
    operation: (expected: AppConnectionContext, root: string) => Promise<VerifiedAction>,
    decision?: VerifiedActionDecision
  ) => {
    if (!canMutate() || busy || uncertain) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setError(null);
    let token: string | null = null;
    try {
      if (guardState.markerId) {
        if (
          !decision ||
          guardState.operation !== 'manifest' ||
          !guardState.unknown ||
          !guardState.checked
        ) {
          throw new Error('Another task operation requires attention');
        }
        await guard.confirmGuardedTaskWriteOutcome(guardState.markerId, 'manifest');
      }
      const started = await guard.beginGuardedTaskWrite('manifest');
      token = started.token;
      const result = await withDeadline(
        operation(started.expectedContext, started.expectedRootFingerprint)
      );
      const unknown =
        decision !== 'leave_unresolved' &&
        (result.status === 'question' || result.status === 'running' || result.status === 'manual');
      if (
        !(await guard.settleGuardedTaskWrite(token, 'manifest', unknown ? 'unknown' : 'confirmed'))
      ) {
        throw new Error('Task write marker changed');
      }
      token = null;
      if (generation.current !== requestGeneration) return;
      setActions((previous) => [
        ...(previous ?? []).filter((item) => item.id !== result.id),
        result,
      ]);
    } catch {
      if (token)
        await guard.settleGuardedTaskWrite(token, 'manifest', 'unknown').catch(() => false);
      if (generation.current !== requestGeneration) return;
      setUncertain(Boolean(token));
      setError(t(token ? 'verifiedAction.resultUnknown' : 'verifiedAction.guardUnavailable'));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  };

  const checkOutcome = async () => {
    if (
      !bridge ||
      !expectedRef.current ||
      !rootRef.current ||
      !guardState.markerId ||
      guardState.operation !== 'manifest'
    )
      return;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      const actions = await bridge.list(
        contextId,
        expectedRef.current,
        rootRef.current,
        teamName,
        taskId
      );
      await guard.checkGuardedTaskWriteOutcome('manifest');
      if (generation.current !== requestGeneration) return;
      setActions(actions);
      setUncertain(false);
      setError(null);
    } catch {
      if (generation.current !== requestGeneration) return;
      setError(t('verifiedAction.refreshFailed'));
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  };

  const allowAfterManualCheck = async () => {
    if (!guardState.markerId || guardState.operation !== 'manifest' || !guardState.checked) return;
    const requestGeneration = generation.current;
    setBusy(true);
    try {
      await guard.confirmGuardedTaskWriteOutcome(guardState.markerId, 'manifest');
      if (generation.current !== requestGeneration) return;
      setUncertain(false);
      setError(null);
    } catch {
      if (generation.current !== requestGeneration) return;
      setError(t('verifiedAction.guardUnavailable'));
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
  const canStart =
    guardState.status === 'ready' &&
    !guardState.activeId &&
    !guardState.markerId &&
    !guardState.unknown &&
    !!guardState.expectedContext &&
    !!guardState.expectedRootFingerprint;
  const canDecide =
    canStart ||
    (guardState.status === 'ready' &&
      guardState.operation === 'manifest' &&
      guardState.unknown &&
      guardState.checked &&
      !guardState.activeId);
  const decide = (action: VerifiedAction, decision: VerifiedActionDecision) =>
    void mutate(
      (expected, root) => bridge.decide(contextId, expected, root, action.id, decision),
      decision
    );

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
      {!canStart &&
      !(
        guardState.status === 'ready' &&
        guardState.operation === 'manifest' &&
        guardState.unknown &&
        guardState.markerId
      ) ? (
        <p className="mt-2">{t('verifiedAction.guardBlocked')}</p>
      ) : null}
      {guardState.status === 'ready' &&
      guardState.operation === 'manifest' &&
      guardState.unknown &&
      guardState.markerId ? (
        <div className="mt-2" role="status">
          <p>{t('verifiedAction.guardUnknown')}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={busy || !canMutate()}
            onClick={() => void checkOutcome()}
          >
            {t('verifiedAction.guardCheck')}
          </Button>
          {guardState.checked ? <p className="mt-2">{t('verifiedAction.guardChecked')}</p> : null}
          {guardState.checked && !actions?.some((item) => item.status === 'question') ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy || !canMutate()}
              onClick={() => void allowAfterManualCheck()}
            >
              {t('verifiedAction.guardAllow')}
            </Button>
          ) : null}
        </div>
      ) : null}
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
                disabled={busy || uncertain || !canMutate() || !canStart}
                onClick={() =>
                  void mutate((expected, root) =>
                    bridge.approve(contextId, expected, root, action.id)
                  )
                }
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
                  disabled={busy || uncertain || !canMutate() || !canDecide}
                  onClick={() => decide(action, 'completed')}
                >
                  {t('verifiedAction.completed')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || uncertain || !canMutate() || !canDecide}
                  onClick={() => decide(action, 'retry_once')}
                >
                  {t('verifiedAction.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || uncertain || !canMutate() || !canDecide}
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
          disabled={busy || uncertain || !canMutate() || !canStart}
          onClick={() =>
            void mutate((expected, root) =>
              bridge.prepare(contextId, expected, root, teamName, taskId)
            )
          }
        >
          {t('verifiedAction.prepare')}
        </Button>
      ) : null}
    </section>
  );
};
