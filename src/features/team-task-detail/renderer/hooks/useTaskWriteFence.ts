import { useCallback } from 'react';

import { useStore } from '@renderer/store';

import { taskWriteGuardStorage } from '../adapters/taskWriteGuardStorage';

import type { TaskDetailIdentity, TaskWriteDecision, TaskWriteOperation } from '../../contracts';

function sameDecision(
  left: TaskWriteDecision | null | undefined,
  right: TaskWriteDecision | null | undefined
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.actionId === right.actionId &&
    left.decisionId === right.decisionId &&
    left.decision === right.decision
  );
}

/** Owns the durable claim on an uncertainty-recovery fence, without dispatching it. */
export function useTaskWriteFence({
  identity,
  identityKey,
  isOriginCurrent,
  withDeadline,
}: {
  identity: TaskDetailIdentity;
  identityKey: string;
  isOriginCurrent: () => boolean;
  withDeadline: <T>(operation: Promise<T>) => Promise<T>;
}) {
  const markGuardedDecisionFenceSent = useCallback(
    async (
      token: string,
      rootFingerprint: string,
      decision: TaskWriteDecision
    ): Promise<string | null> => {
      const state = useStore.getState();
      const session = state.taskDetailSessionById[identityKey];
      if (
        !isOriginCurrent() ||
        session?.taskWriteRootFingerprint !== rootFingerprint ||
        session.taskWriteMarkerId !== token ||
        session.taskWriteOperation !== 'manifest' ||
        !session.taskWriteDecision ||
        session.taskWriteDecision.actionId !== decision.actionId ||
        session.taskWriteDecision.decisionId !== decision.decisionId ||
        session.taskWriteDecision.decision !== decision.decision ||
        session.taskWriteDecision.stage !== 'decision'
      )
        return null;
      const marker = {
        version: 1 as const,
        attemptId: token,
        operation: 'manifest' as const,
        decision: session.taskWriteDecision,
      };
      const claimId = crypto.randomUUID();
      const claimed = await withDeadline(
        taskWriteGuardStorage.markFenceSent(
          { ...identity, dataRootFingerprint: rootFingerprint },
          marker,
          claimId
        )
      );
      const latest = useStore.getState();
      const current = latest.taskDetailSessionById[identityKey];
      if (
        claimed &&
        current?.taskWriteMarkerId === token &&
        current.taskWriteRootFingerprint === rootFingerprint &&
        current.taskWriteDecision?.decisionId === decision.decisionId &&
        current.taskWriteDecision.actionId === decision.actionId &&
        current.taskWriteDecision.decision === decision.decision
      )
        latest.updateTaskDetailSession(identity, {
          taskWriteDecision: { ...session.taskWriteDecision, stage: 'fenceSent' },
        });
      return claimed ? claimId : null;
    },
    [identity, identityKey, isOriginCurrent, withDeadline]
  );

  const releaseUnadmittedDecisionFence = useCallback(
    async (
      token: string,
      rootFingerprint: string,
      decision: TaskWriteDecision,
      claimId: string
    ): Promise<boolean> => {
      // This closure retains the original task identity even if the view changed.
      const released = await withDeadline(
        taskWriteGuardStorage.releaseUnadmittedFence(
          { ...identity, dataRootFingerprint: rootFingerprint },
          { version: 1, attemptId: token, operation: 'manifest', decision },
          claimId
        )
      );
      const latest = useStore.getState();
      const current = latest.taskDetailSessionById[identityKey];
      if (
        released &&
        current?.taskWriteMarkerId === token &&
        current.taskWriteRootFingerprint === rootFingerprint &&
        current.taskWriteDecision?.decisionId === decision.decisionId &&
        current.taskWriteDecision.actionId === decision.actionId &&
        current.taskWriteDecision.decision === decision.decision &&
        current.taskWriteDecision.stage === 'fenceSent'
      )
        latest.updateTaskDetailSession(identity, {
          taskWriteDecision: { ...current.taskWriteDecision, stage: 'decision' },
          artifactOutcomeChecked: false,
        });
      return released;
    },
    [identity, identityKey, withDeadline]
  );

  const syncGuardedOutcome = useCallback(
    async (
      token: string,
      rootFingerprint: string,
      operation: TaskWriteOperation,
      decision: TaskWriteDecision | null,
      revision: number
    ) => {
      // Read the marker and its receipts in one durable snapshot. A missing
      // marker alone does not prove success, cancellation, or a user decision.
      const snapshot = await withDeadline(
        taskWriteGuardStorage.readDecision(
          { ...identity, dataRootFingerprint: rootFingerprint },
          { version: 1, attemptId: token, operation }
        )
      );
      const stored = snapshot.marker;
      const resolution = snapshot.confirmed
        ? 'confirmed'
        : snapshot.cancelled
          ? 'cancelled'
          : snapshot.explicitlyResolved
            ? 'explicit'
            : undefined;
      if (
        stored
          ? resolution ||
            stored.attemptId !== token ||
            stored.operation !== operation ||
            !sameDecision(stored.decision, decision)
          : !resolution && operation !== 'artifact'
      )
        throw new Error('Task outcome changed during the check');
      const state = useStore.getState();
      const session = state.taskDetailSessionById[identityKey];
      if (
        !isOriginCurrent() ||
        !session?.artifactOutcomeUnknown ||
        session.artifactWriteId ||
        session.taskWriteMarkerId !== token ||
        session.taskWriteOperation !== operation ||
        session.taskWriteRootFingerprint !== rootFingerprint ||
        (session.artifactOutcomeRevision ?? 0) !== revision ||
        !sameDecision(session.taskWriteDecision, decision)
      )
        throw new Error('Task outcome changed during the check');
      if (!stored) {
        if (resolution)
          return {
            markerId: token,
            decision: null,
            resolved: true,
            resolution,
          } as const;
        // A missing artifact marker without a receipt remains unknown; the
        // user may still inspect and explicitly confirm it as before.
        return { markerId: token, decision: null };
      }
      const currentDecision = stored.decision ?? null;
      state.updateTaskDetailSession(identity, { taskWriteDecision: currentDecision });
      return { markerId: token, decision: currentDecision };
    },
    [identity, identityKey, isOriginCurrent, withDeadline]
  );

  return { markGuardedDecisionFenceSent, releaseUnadmittedDecisionFence, syncGuardedOutcome };
}
