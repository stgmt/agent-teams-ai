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

import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';

interface TeamReviewRecoveryProps {
  teamName: string;
  error: string;
  onRecovered: () => void;
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
  const taskId = error.match(/Review transition for task (\S+) has an unknown outcome/)?.[1];
  const [snapshot, setSnapshot] = useState<PendingKanbanTransitionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const sequence = useRef(0);
  const inspectedScope = useRef<{ contextId: string; epoch: number } | null>(null);

  useEffect(() => {
    setSnapshot(null);
    inspectedScope.current = null;
    setFailure(false);
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
    setSnapshot(null);
    try {
      const result = await api.teams.inspectPendingKanbanTransition(teamName, taskId);
      if (sequence.current === current && isScopeCurrent(scope)) {
        inspectedScope.current = scope;
        setSnapshot(result);
      }
    } catch {
      if (sequence.current === current) setFailure(true);
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  };

  const resolve = async (): Promise<void> => {
    if (
      !taskId ||
      !snapshot ||
      snapshot.mode === 'conflict' ||
      !snapshot.snapshotHash ||
      busy ||
      !inspectedScope.current ||
      !isScopeCurrent(inspectedScope.current)
    )
      return;
    const scope = inspectedScope.current;
    const current = ++sequence.current;
    setBusy(true);
    const accepted = await confirm({
      title: t('artifact.recoveryConfirm'),
      message: t('artifact.recoveryConfirmMessage'),
      confirmLabel: t('artifact.recoveryConfirm'),
      cancelLabel: tCommon('actions.cancel'),
    });
    if (sequence.current !== current) return;
    if (!isScopeCurrent(scope)) {
      setBusy(false);
      setSnapshot(null);
      setFailure(true);
      return;
    }
    if (!accepted) {
      setBusy(false);
      return;
    }
    setSnapshot(null);
    try {
      await api.teams.resolvePendingKanbanTransition(teamName, taskId, snapshot);
      if (sequence.current === current && isScopeCurrent(scope)) onRecovered();
    } catch {
      if (sequence.current === current) setFailure(true);
    } finally {
      if (sequence.current === current) setBusy(false);
    }
  };

  const columnLabel = (column: string | null | undefined): string =>
    column === 'review'
      ? t('artifact.recoveryReview')
      : column === 'approved'
        ? t('artifact.recoveryApproved')
        : t('artifact.recoveryNone');

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
                  {t('artifact.recoverySummary', {
                    task: snapshot.taskId,
                    target: columnLabel(snapshot.column),
                    current: columnLabel(snapshot.currentColumn),
                  })}
                </p>
              ) : null}
              {snapshot?.reason === 'artifact_invalid' ? (
                <p>{t('artifact.recoveryArtifactConflict')}</p>
              ) : null}
              {snapshot?.mode === 'conflict' ? <p>{t('artifact.recoveryConflict')}</p> : null}
              {snapshot && snapshot.mode !== 'conflict' ? (
                <Button type="button" size="sm" disabled={busy} onClick={() => void resolve()}>
                  {t('artifact.recoveryConfirm')}
                </Button>
              ) : null}
              {failure ? <p>{t('artifact.recoveryFailed')}</p> : null}
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
