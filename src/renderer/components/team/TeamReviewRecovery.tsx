import { useEffect, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import { kanbanRecoveryDecisionStorage } from './kanbanRecoveryDecision';

import type { RecoveryDecisionPhase, RecoveryDecisionRecord } from './kanbanRecoveryDecision';
import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';

interface TeamReviewRecoveryProps {
  teamName: string;
  error: string;
  onRecovered: () => void;
}

const RECOVERY_OUTCOME_TIMEOUT_MS = 30_000;

function waitForRecoveryOutcome<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Recovery outcome is unknown')),
      RECOVERY_OUTCOME_TIMEOUT_MS
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const TeamReviewRecovery = ({
  teamName,
  error,
  onRecovered,
}: TeamReviewRecoveryProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const contextId = useStore((state) => state.activeContextId);
  const isContextSwitching = useStore((state) => state.isContextSwitching);
  const taskId = error.match(
    /(?:Review|Task status) transition for task (\S+) has an unknown outcome/
  )?.[1];
  const [snapshot, setSnapshot] = useState<PendingKanbanTransitionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [inspectFailure, setInspectFailure] = useState(false);
  const [decision, setDecision] = useState<RecoveryDecisionPhase | 'unavailable' | null>(null);
  const sequence = useRef(0);
  const confirming = useRef(false);
  const inspectedScope = useRef<{ contextId: string; epoch: number } | null>(null);
  const statusModeValid =
    snapshot?.column !== 'none' ||
    (['pending', 'in_progress', 'completed', 'deleted'].includes(snapshot.targetStatus ?? '') &&
      ['status', 'clear', 'request_changes'].includes(snapshot.operation ?? '') &&
      ((snapshot.mode === 'cancel' && snapshot.phase === 'prepared') ||
        ((snapshot.mode === 'publish' || snapshot.mode === 'clear') &&
          snapshot.phase === 'applied')));
  const canResolve =
    !!snapshot &&
    !decision &&
    snapshot.mode !== 'conflict' &&
    !!snapshot.snapshotHash &&
    statusModeValid &&
    (snapshot.column === 'none' || snapshot.mode !== 'cancel');
  const statusDetail =
    snapshot?.mode === 'cancel'
      ? snapshot.operation === 'clear'
        ? t('artifact.recoveryClearCancel')
        : t('artifact.recoveryStatusCancel')
      : snapshot?.mode === 'publish'
        ? t('artifact.recoveryStatusPublish')
        : t('artifact.recoveryStatusClear');

  useEffect(() => {
    setSnapshot(null);
    inspectedScope.current = null;
    setFailure(false);
    setInspectFailure(false);
    setDecision(null);
    setBusy(false);
    return () => {
      sequence.current += 1;
    };
  }, [teamName, taskId, contextId, isContextSwitching]);

  const isScopeCurrent = (scope: { contextId: string; epoch: number }): boolean => {
    const state = useStore.getState();
    return (
      !state.isContextSwitching &&
      state.activeContextId === scope.contextId &&
      isContextScopedRequestEpochCurrent(scope.epoch)
    );
  };

  const check = async (): Promise<void> => {
    if (!taskId || busy || isContextSwitching) return;
    const current = ++sequence.current;
    const scope = { contextId, epoch: captureContextScopedRequestEpoch() };
    setBusy(true);
    setFailure(false);
    setInspectFailure(false);
    setDecision(null);
    setSnapshot(null);
    let decisionStorageFailed = false;
    try {
      const result = await waitForRecoveryOutcome(
        api.teams.inspectPendingKanbanTransition(teamName, taskId)
      );
      if (result.taskId !== taskId) throw new Error('Recovery task changed');
      let existing: RecoveryDecisionRecord | null = null;
      if (result.mode !== 'conflict' && result.snapshotHash) {
        try {
          existing = await waitForRecoveryOutcome(kanbanRecoveryDecisionStorage.read(result));
        } catch (error) {
          decisionStorageFailed = true;
          throw error;
        }
      }
      if (sequence.current === current && isScopeCurrent(scope)) {
        inspectedScope.current = scope;
        setSnapshot(result);
        if (existing) {
          setDecision(
            kanbanRecoveryDecisionStorage.matches(existing, teamName, result)
              ? existing.phase
              : 'unknown'
          );
        }
      }
    } catch {
      if (sequence.current === current && isScopeCurrent(scope)) {
        setFailure(true);
        setInspectFailure(true);
        if (decisionStorageFailed) setDecision('unavailable');
      }
    } finally {
      if (sequence.current === current) {
        setBusy(false);
        const state = useStore.getState();
        if (
          !isScopeCurrent(scope) &&
          !state.isContextSwitching &&
          state.activeContextId === scope.contextId
        ) {
          setSnapshot(null);
          setFailure(true);
          setInspectFailure(true);
        }
      }
    }
  };

  const resolve = async (): Promise<void> => {
    if (
      !taskId ||
      !snapshot ||
      !canResolve ||
      busy ||
      confirming.current ||
      !inspectedScope.current
    )
      return;
    const scope = inspectedScope.current;
    if (!isScopeCurrent(scope)) {
      setSnapshot(null);
      setFailure(true);
      setInspectFailure(true);
      return;
    }
    const current = ++sequence.current;
    confirming.current = true;
    setBusy(true);
    let sent = false;
    let questionShown = false;
    try {
      const claim = await waitForRecoveryOutcome(
        kanbanRecoveryDecisionStorage.claim(teamName, snapshot)
      );
      if (!claim.claimed) {
        if (sequence.current === current && isScopeCurrent(scope)) {
          setDecision(
            kanbanRecoveryDecisionStorage.matches(claim.record, teamName, snapshot)
              ? claim.record.phase
              : 'unknown'
          );
        }
        return;
      }
      if (sequence.current !== current || !isScopeCurrent(scope)) {
        // The question was never shown and no request was sent.
        await waitForRecoveryOutcome(
          kanbanRecoveryDecisionStorage.transition(
            teamName,
            snapshot,
            claim.record.owner,
            ['prompting'],
            null
          )
        );
        return;
      }
      questionShown = true;
      const accepted = await confirm({
        title: t('artifact.recoveryConfirm'),
        message: snapshot.column === 'none' ? statusDetail : t('artifact.recoveryConfirmMessage'),
        confirmLabel: t('artifact.recoveryConfirm'),
        cancelLabel: tCommon('actions.cancel'),
      });
      if (!accepted) {
        await waitForRecoveryOutcome(
          kanbanRecoveryDecisionStorage.transition(
            teamName,
            snapshot,
            claim.record.owner,
            ['prompting'],
            'declined'
          )
        );
        if (sequence.current === current && isScopeCurrent(scope)) setDecision('declined');
        return;
      }
      if (sequence.current !== current || !isScopeCurrent(scope)) {
        await waitForRecoveryOutcome(
          kanbanRecoveryDecisionStorage.transition(
            teamName,
            snapshot,
            claim.record.owner,
            ['prompting'],
            'not_sent'
          )
        );
        return;
      }
      // Persist the answer before dispatch. A crash or timeout afterwards is
      // deliberately left as unknown; no other window resends the operation.
      await waitForRecoveryOutcome(
        kanbanRecoveryDecisionStorage.transition(
          teamName,
          snapshot,
          claim.record.owner,
          ['prompting'],
          'sending'
        )
      );
      if (sequence.current !== current || !isScopeCurrent(scope)) {
        await waitForRecoveryOutcome(
          kanbanRecoveryDecisionStorage.transition(
            teamName,
            snapshot,
            claim.record.owner,
            ['sending'],
            'not_sent'
          )
        );
        return;
      }
      setSnapshot(null);
      sent = true;
      const completion = api.teams
        .resolvePendingKanbanTransition(teamName, taskId, snapshot)
        .then(() =>
          kanbanRecoveryDecisionStorage.transition(
            teamName,
            snapshot,
            claim.record.owner,
            ['sending'],
            'confirmed'
          )
        );
      // A delayed success may record this exact receipt, but cannot revive this
      // screen after the deadline or operate on a newer transition.
      await waitForRecoveryOutcome(completion);
      if (sequence.current === current && isScopeCurrent(scope)) onRecovered();
    } catch {
      if (sequence.current === current && isScopeCurrent(scope)) {
        setFailure(true);
        setDecision(sent || questionShown ? 'unknown' : 'unavailable');
      }
    } finally {
      confirming.current = false;
      if (sequence.current === current) {
        setBusy(false);
        const state = useStore.getState();
        if (
          !isScopeCurrent(scope) &&
          !state.isContextSwitching &&
          state.activeContextId === scope.contextId
        ) {
          setSnapshot(null);
          setFailure(true);
          setInspectFailure(true);
        }
      }
    }
  };

  const columnLabel = (column: string | null | undefined): string =>
    column === 'review'
      ? t('artifact.recoveryReview')
      : column === 'approved'
        ? t('artifact.recoveryApproved')
        : t('artifact.recoveryNone');
  const statusLabel = (status: PendingKanbanTransitionSnapshot['targetStatus']): string =>
    status === 'pending'
      ? t('artifact.recoveryStatusPending')
      : status === 'in_progress'
        ? t('artifact.recoveryStatusInProgress')
        : status === 'completed'
          ? t('artifact.recoveryStatusCompleted')
          : status === 'deleted'
            ? t('artifact.recoveryStatusDeleted')
            : t('artifact.recoveryStatusUnknown');

  return (
    <div className="flex size-full items-center justify-center p-6">
      <div className="text-center">
        <p className="text-sm font-medium text-red-400">{t('detail.loadFailed')}</p>
        <div role="alert" className="mt-2 space-y-3 text-xs text-[var(--color-text-muted)]">
          <p>{error}</p>
          {taskId ? (
            <>
              <p>{t('artifact.recoveryIntro')}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void check()}
              >
                {t('artifact.recoveryCheck')}
              </Button>
              {snapshot ? (
                <p>
                  {snapshot.column === 'none'
                    ? t(
                        snapshot.operation === 'clear'
                          ? 'artifact.recoveryClearSummary'
                          : 'artifact.recoveryStatusSummary',
                        {
                          task: snapshot.taskId,
                          status: statusLabel(snapshot.targetStatus),
                          current: columnLabel(snapshot.currentColumn),
                        }
                      )
                    : t('artifact.recoverySummary', {
                        task: snapshot.taskId,
                        target: columnLabel(snapshot.column),
                        current: columnLabel(snapshot.currentColumn),
                      })}
                </p>
              ) : null}
              {snapshot?.column === 'none' && canResolve ? <p>{statusDetail}</p> : null}
              {snapshot?.operation === 'request_changes' ? (
                <p>{t('artifact.recoveryRequestChangesNote')}</p>
              ) : null}
              {snapshot?.reason === 'artifact_invalid' ? (
                <p>{t('artifact.recoveryArtifactConflict')}</p>
              ) : null}
              {snapshot && !canResolve && !decision ? (
                <p>{t('artifact.recoveryConflict')}</p>
              ) : null}
              {snapshot && canResolve ? (
                <Button type="button" size="sm" disabled={busy} onClick={() => void resolve()}>
                  {t('artifact.recoveryConfirm')}
                </Button>
              ) : null}
              {failure ? (
                <>
                  <p>{t('artifact.recoveryFailed')}</p>
                  {inspectFailure ? <p>{t('artifact.recoveryInspectFailed')}</p> : null}
                  <Button type="button" size="sm" variant="outline" onClick={onRecovered}>
                    {t('artifact.recoveryReload')}
                  </Button>
                </>
              ) : null}
              {decision ? (
                <>
                  <p>
                    {decision === 'confirmed'
                      ? t('artifact.recoveryDecisionConfirmed')
                      : decision === 'declined'
                        ? t('artifact.recoveryDecisionDeclined')
                        : decision === 'not_sent'
                          ? t('artifact.recoveryDecisionNotSent')
                          : decision === 'unavailable'
                            ? t('artifact.recoveryDecisionUnavailable')
                            : t('artifact.recoveryDecisionPending')}
                  </p>
                  {decision === 'confirmed' ? (
                    <Button type="button" size="sm" variant="outline" onClick={onRecovered}>
                      {t('artifact.recoveryReload')}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </>
          ) : error.includes('KANBAN_SNAPSHOT_CHANGED') ? (
            <>
              <p>{t('artifact.recoveryReadChanged')}</p>
              <Button type="button" size="sm" onClick={onRecovered}>
                {t('artifact.recoveryReload')}
              </Button>
            </>
          ) : error.includes('Cannot verify') ? (
            <p>{t('artifact.recoveryConflict')}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
};
