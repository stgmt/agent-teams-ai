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
  | 'beginGuardedTaskDecision'
  | 'markGuardedDecisionFenceSent'
  | 'readGuardedTaskDecisionIds'
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
  artifactRevision,
  canMutate,
  guard,
}: {
  contextId: string;
  teamName: string;
  taskId: string;
  enabled: boolean;
  artifactRevision?: string;
  canMutate: () => boolean;
  guard: TaskGuard;
}): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const [actions, setActions] = useState<VerifiedAction[] | null>(null);
  const [decidedActionIds, setDecidedActionIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const readGeneration = useRef(0);
  const mounted = useRef(false);
  const checkingOutcome = useRef<number | null>(null);
  const bridge = api.verifiedAction;
  const guardState = guard.taskWriteGuard;
  const { readGuardedTaskDecisionIds } = guard;
  const expectedRef = useRef(guardState.expectedContext);
  expectedRef.current = guardState.expectedContext;
  const rootRef = useRef(guardState.expectedRootFingerprint);
  rootRef.current = guardState.expectedRootFingerprint;
  const expectedKey = guardState.expectedContext ? JSON.stringify(guardState.expectedContext) : '';
  const rootKey = guardState.expectedRootFingerprint ?? '';
  const identityKey = JSON.stringify([contextId, teamName, taskId, rootKey, artifactRevision]);
  const identity = useRef({ key: identityKey, revision: 0 });
  if (identity.current.key !== identityKey) {
    identity.current = { key: identityKey, revision: identity.current.revision + 1 };
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const expected = expectedRef.current;
    const root = rootRef.current;
    if (!bridge || !expected || !expectedKey || !root || !rootKey) return false;
    const requestGeneration = generation.current;
    const readId = ++readGeneration.current;
    setBusy(true);
    try {
      const [result, decided] = await Promise.all([
        withDeadline(bridge.list(contextId, expected, root, teamName, taskId)),
        readGuardedTaskDecisionIds(),
      ]);
      if (generation.current !== requestGeneration || readGeneration.current !== readId)
        return false;
      setActions(result);
      setDecidedActionIds(decided);
      setUncertain(false);
      setError(null);
      return true;
    } catch {
      if (generation.current !== requestGeneration || readGeneration.current !== readId)
        return false;
      setUncertain(true);
      setError(t('verifiedAction.refreshFailed'));
      return false;
    } finally {
      if (generation.current === requestGeneration && readGeneration.current === readId)
        setBusy(false);
    }
  }, [bridge, contextId, expectedKey, rootKey, t, taskId, teamName, readGuardedTaskDecisionIds]);

  useEffect(() => {
    generation.current += 1;
    setActions(null);
    setDecidedActionIds([]);
    if (checkingOutcome.current !== identity.current.revision) setBusy(false);
    setError(null);
    setUncertain(false);
    if (
      bridge &&
      contextId === 'local' &&
      expectedKey &&
      rootKey &&
      checkingOutcome.current !== identity.current.revision
    )
      void refresh();
    return () => {
      generation.current += 1;
    };
  }, [enabled, artifactRevision, bridge, contextId, expectedKey, rootKey, refresh]);

  useEffect(() => {
    if (!bridge || contextId !== 'local' || !expectedKey || !rootKey) return;
    const onFocus = () => {
      if (checkingOutcome.current !== identity.current.revision) void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [bridge, contextId, expectedKey, rootKey, refresh]);

  const mutate = async (
    operation: (expected: AppConnectionContext, root: string) => Promise<VerifiedAction>,
    decision?: { actionId: string; choice: VerifiedActionDecision }
  ) => {
    if (!canMutate() || busy || uncertain) return;
    const requestGeneration = generation.current;
    setBusy(true);
    setError(null);
    let token: string | null = null;
    try {
      const startedDecision = decision
        ? await guard.beginGuardedTaskDecision(decision.actionId, decision.choice)
        : null;
      const started = startedDecision ?? (await guard.beginGuardedTaskWrite('manifest'));
      token = started.token;
      const result = await withDeadline(
        decision
          ? bridge!.decide(
              contextId,
              started.expectedContext,
              started.expectedRootFingerprint,
              decision.actionId,
              decision.choice,
              startedDecision!.decision.decisionId
            )
          : operation(started.expectedContext, started.expectedRootFingerprint)
      );
      const unknown =
        result.status === 'question' ||
        result.status === 'running' ||
        (!!decision &&
          (!startedDecision ||
            result.decisionReceipt?.id !== startedDecision.decision.decisionId ||
            result.decisionReceipt?.decision !== decision.choice));
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
      if (!token && decision) {
        try {
          const decided = await readGuardedTaskDecisionIds();
          if (decided.includes(decision.actionId) && (await refresh())) return;
        } catch {
          // A failed receipt read cannot prove another window handled this decision.
        }
      }
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
      guardState.operation !== 'manifest' ||
      checkingOutcome.current === identity.current.revision
    )
      return;
    const requestIdentity = identity.current.revision;
    const isCurrent = () => mounted.current && identity.current.revision === requestIdentity;
    checkingOutcome.current = requestIdentity;
    readGeneration.current += 1;
    setBusy(true);
    try {
      // Rebind the same physical root first. A stale connection generation
      // cannot safely be used to read or fence the saved manifest decision.
      const binding = await guard.checkGuardedTaskWriteOutcome('manifest');
      if (!isCurrent()) return;
      const [actions, decided] = await Promise.all([
        withDeadline(
          bridge.list(
            contextId,
            binding.expectedContext,
            binding.expectedRootFingerprint,
            teamName,
            taskId
          )
        ),
        readGuardedTaskDecisionIds(),
      ]);
      if (!isCurrent()) return;
      let nextActions = actions;
      const decision = guardState.decision;
      if (decision) {
        let target = actions.find((item) => item.id === decision.actionId);
        const matches = () =>
          target?.decisionReceipt?.id === decision.decisionId &&
          target.decisionReceipt.decision === decision.decision &&
          (target.status === 'manual' || target.status === 'completed');
        if (!matches() && target?.status === 'question' && decision.stage === 'decision') {
          if (await guard.markGuardedDecisionFenceSent(guardState.markerId)) {
            if (!isCurrent()) return;
            target = await withDeadline(
              bridge.fenceDecision(
                contextId,
                binding.expectedContext,
                binding.expectedRootFingerprint,
                decision.actionId,
                decision.decision,
                decision.decisionId
              )
            );
            nextActions = [...actions.filter((item) => item.id !== target!.id), target];
          }
        }
        if (!isCurrent()) return;
        if (matches()) {
          await guard.confirmGuardedTaskWriteOutcome(guardState.markerId, 'manifest');
          if (!isCurrent()) return;
        } else {
          setActions(nextActions);
          setError(t('verifiedAction.manual'));
          return;
        }
      }
      setActions(nextActions);
      setDecidedActionIds(decided);
      setUncertain(false);
      setError(null);
    } catch {
      if (!isCurrent()) return;
      setUncertain(true);
      setError(t('verifiedAction.refreshFailed'));
    } finally {
      if (checkingOutcome.current === requestIdentity) checkingOutcome.current = null;
      if (isCurrent()) setBusy(false);
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

  // An interrupted preparation may have no saved action yet. Its marker must
  // remain reachable even if another window disabled the requirement.
  const hasManifestMarker = guardState.operation === 'manifest' && !!guardState.markerId;
  if (
    contextId !== 'local' ||
    !bridge ||
    (!enabled && (!actions || actions.length === 0) && !hasManifestMarker)
  )
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
      !guardState.activeId &&
      !guardState.decision);
  const decide = (action: VerifiedAction, decision: VerifiedActionDecision) =>
    void mutate(async () => action, { actionId: action.id, choice: decision });

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
          {guardState.checked &&
          !guardState.decision &&
          actions !== null &&
          !uncertain &&
          !actions?.some((item) => item.status === 'question') ? (
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
          {action.status === 'question' &&
          guardState.decision?.actionId !== action.id &&
          !decidedActionIds.includes(action.id) ? (
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
          {action.status === 'stale' ? <p className="mt-2">{t('verifiedAction.stale')}</p> : null}
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
