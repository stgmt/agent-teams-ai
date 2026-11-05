import { useCallback, useEffect } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';

import {
  ArtifactWriteNotStartedError,
  ArtifactWriteOutcomeHandledError,
} from '../../core/domain/taskArtifactOutcome';
import {
  TaskWriteGuardOccupiedError,
  taskWriteGuardStorage,
} from '../adapters/taskWriteGuardStorage';

import type { TaskDetailIdentity, TaskDetailSession, TaskWriteOperation } from '../../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TaskFieldUpdates } from '@shared/types';

const ARTIFACT_OUTCOME_TIMEOUT_MS = 30_000;

function withArtifactOutcomeDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Task artifact operation timed out')),
      ARTIFACT_OUTCOME_TIMEOUT_MS
    );
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type GuardContext = AppConnectionContext & { physicalRootFingerprint: string };

function sameGuardContext(
  a: AppConnectionContext,
  root: string | null | undefined,
  b: GuardContext
): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration &&
    !!root &&
    root === b.physicalRootFingerprint
  );
}

function connectionContext(value: GuardContext): AppConnectionContext {
  return {
    appInstanceId: value.appInstanceId,
    dataRootFingerprint: value.dataRootFingerprint,
    connectionGeneration: value.connectionGeneration,
  };
}

export function useTaskWriteGuard({
  identity,
  identityKey,
  session,
  isOriginCurrent,
  requireOwner,
}: {
  identity: TaskDetailIdentity;
  identityKey: string;
  session: TaskDetailSession;
  isOriginCurrent: () => boolean;
  requireOwner: () => boolean;
}) {
  const readGuardContext = useCallback(async (): Promise<GuardContext> => {
    if (!isOriginCurrent() || identity.contextId !== 'local' || !isElectronMode())
      throw new Error('Local Electron task context is required');
    const info = await withArtifactOutcomeDeadline(api.externalAgentConnection.getConnectionInfo());
    const context = info.context;
    if (
      !isOriginCurrent() ||
      !context ||
      typeof context.appInstanceId !== 'string' ||
      !context.appInstanceId ||
      !/^[a-f0-9]{64}$/i.test(context.dataRootFingerprint) ||
      typeof info.taskWriteRootFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(info.taskWriteRootFingerprint) ||
      !Number.isSafeInteger(context.connectionGeneration) ||
      context.connectionGeneration < 1
    ) {
      throw new Error('Task data root identity is unavailable');
    }
    return { ...context, physicalRootFingerprint: info.taskWriteRootFingerprint };
  }, [identity.contextId, isOriginCurrent]);
  useEffect(() => {
    if (!isOriginCurrent() || session.taskWriteGuardState) return;
    if (identity.contextId !== 'local' || !isElectronMode()) {
      useStore.getState().updateTaskDetailSession(identity, {
        taskWriteGuardState: 'unavailable',
        taskWriteGuardReason: 'unsupported',
      });
      return;
    }
    const hydrationId = crypto.randomUUID();
    useStore.getState().updateTaskDetailSession(identity, {
      taskWriteGuardState: 'loading',
      taskWriteHydrationId: hydrationId,
    });
    void (async () => {
      const context = await readGuardContext();
      const marker = await withArtifactOutcomeDeadline(
        taskWriteGuardStorage.read({
          ...identity,
          dataRootFingerprint: context.physicalRootFingerprint,
        })
      );
      if (!sameGuardContext(context, context.physicalRootFingerprint, await readGuardContext()))
        throw new Error('Task context changed');
      return { marker, context };
    })()
      .then(({ marker, context }) => {
        const state = useStore.getState();
        const current = state.taskDetailSessionById[identityKey];
        if (current?.taskWriteHydrationId !== hydrationId) return;
        state.updateTaskDetailSession(
          identity,
          marker
            ? {
                taskWriteGuardState: 'ready',
                taskWriteMarkerId: marker.attemptId,
                taskWriteOperation: marker.operation,
                taskWriteRootFingerprint: context.physicalRootFingerprint,
                taskWriteExpectedContext: connectionContext(context),
                artifactOutcomeUnknown: true,
                artifactOutcomeChecked: false,
                artifactOutcomeRevision: (current.artifactOutcomeRevision ?? 0) + 1,
              }
            : {
                taskWriteGuardState: 'ready',
                taskWriteMarkerId: null,
                taskWriteOperation: null,
                taskWriteRootFingerprint: context.physicalRootFingerprint,
                taskWriteExpectedContext: connectionContext(context),
              }
        );
      })
      .catch(() => {
        const state = useStore.getState();
        if (state.taskDetailSessionById[identityKey]?.taskWriteHydrationId === hydrationId) {
          state.updateTaskDetailSession(identity, {
            taskWriteGuardState: 'unavailable',
            taskWriteGuardReason: 'unavailable',
          });
        }
      });
  }, [identity, identityKey, isOriginCurrent, readGuardContext, session.taskWriteGuardState]);

  const markArtifactOutcomeUnknown = useCallback((): void => {
    const state = useStore.getState();
    const current = state.taskDetailSessionById[identityKey];
    if (current?.taskWriteOperation && current.taskWriteOperation !== 'artifact') return;
    const revision = current?.artifactOutcomeRevision ?? 0;
    state.updateTaskDetailSession(identity, {
      artifactOutcomeUnknown: true,
      artifactOutcomeChecked: false,
      artifactOutcomeRevision: revision + 1,
      ...(!current?.taskWriteMarkerId ? { taskWriteGuardState: 'unavailable' as const } : {}),
    });
  }, [identity, identityKey]);

  const beginGuardedTaskWrite = useCallback(
    async (
      operation: TaskWriteOperation
    ): Promise<{
      token: string;
      expectedContext: AppConnectionContext;
      expectedRootFingerprint: string;
    }> => {
      const state = useStore.getState();
      const session = state.taskDetailSessionById[identityKey];
      if (
        !requireOwner() ||
        session?.taskWriteGuardState !== 'ready' ||
        session.artifactOutcomeUnknown ||
        session.artifactWriteId
      ) {
        throw new ArtifactWriteNotStartedError('No task write was sent');
      }
      const token = crypto.randomUUID();
      const marker = { version: 1 as const, attemptId: token, operation };
      state.updateTaskDetailSession(identity, {
        artifactWriteId: token,
        taskWriteOperation: operation,
      });
      let context: GuardContext;
      try {
        context = await readGuardContext();
        if (context.physicalRootFingerprint !== session.taskWriteRootFingerprint)
          throw new Error('Task data root changed');
        await withArtifactOutcomeDeadline(
          taskWriteGuardStorage.acquire(
            { ...identity, dataRootFingerprint: context.physicalRootFingerprint },
            marker
          )
        );
      } catch (error) {
        const latest = useStore.getState();
        const current = latest.taskDetailSessionById[identityKey];
        if (current?.artifactWriteId === token) {
          latest.updateTaskDetailSession(
            identity,
            error instanceof TaskWriteGuardOccupiedError
              ? {
                  artifactWriteId: null,
                  taskWriteGuardState: 'ready',
                  taskWriteMarkerId: error.marker.attemptId,
                  taskWriteOperation: error.marker.operation,
                  taskWriteExpectedContext: connectionContext(context!),
                  artifactOutcomeUnknown: true,
                  artifactOutcomeChecked: false,
                  artifactOutcomeRevision: (current.artifactOutcomeRevision ?? 0) + 1,
                }
              : { artifactWriteId: null, taskWriteGuardState: 'unavailable' }
          );
        }
        throw new ArtifactWriteNotStartedError(
          'Task write safety storage is unavailable or occupied'
        );
      }
      const latest = useStore.getState();
      let sameContext = false;
      try {
        sameContext = sameGuardContext(
          context,
          context.physicalRootFingerprint,
          await readGuardContext()
        );
      } catch {
        /* fail closed */
      }
      if (
        !sameContext ||
        !requireOwner() ||
        latest.taskDetailSessionById[identityKey]?.artifactWriteId !== token
      ) {
        try {
          await withArtifactOutcomeDeadline(
            taskWriteGuardStorage.release(
              { ...identity, dataRootFingerprint: context.physicalRootFingerprint },
              marker
            )
          );
        } catch {
          latest.updateTaskDetailSession(identity, { taskWriteGuardState: 'unavailable' });
        }
        if (latest.taskDetailSessionById[identityKey]?.artifactWriteId === token)
          latest.updateTaskDetailSession(identity, {
            artifactWriteId: null,
            taskWriteOperation: null,
          });
        throw new ArtifactWriteNotStartedError('Task context changed before the write');
      }
      latest.updateTaskDetailSession(identity, {
        taskWriteMarkerId: token,
        taskWriteExpectedContext: connectionContext(context),
      });
      return {
        token,
        expectedContext: connectionContext(context),
        expectedRootFingerprint: context.physicalRootFingerprint,
      };
    },
    [identity, identityKey, readGuardContext, requireOwner]
  );

  const settleGuardedTaskWrite = useCallback(
    async (
      token: string,
      operation: TaskWriteOperation,
      outcome: 'confirmed' | 'unknown'
    ): Promise<boolean> => {
      const state = useStore.getState();
      const current = state.taskDetailSessionById[identityKey];
      if (
        current?.artifactWriteId !== token ||
        current.taskWriteOperation !== operation ||
        current.taskWriteMarkerId !== token
      )
        return false;
      const markUnknown = (): void => {
        const latest = useStore.getState();
        const session = latest.taskDetailSessionById[identityKey];
        if (session?.artifactWriteId !== token || session.taskWriteOperation !== operation) return;
        latest.updateTaskDetailSession(identity, {
          artifactWriteId: null,
          artifactOutcomeUnknown: true,
          artifactOutcomeChecked: false,
          artifactOutcomeRevision: (session.artifactOutcomeRevision ?? 0) + 1,
        });
      };
      if (outcome === 'unknown') {
        markUnknown();
        return true;
      }
      try {
        if (
          !current.taskWriteExpectedContext ||
          !sameGuardContext(
            current.taskWriteExpectedContext,
            current.taskWriteRootFingerprint,
            await readGuardContext()
          )
        )
          throw new Error('Task context changed');
        await withArtifactOutcomeDeadline(
          taskWriteGuardStorage.release(
            {
              ...identity,
              dataRootFingerprint: current.taskWriteRootFingerprint!,
            },
            { version: 1, attemptId: token, operation }
          )
        );
      } catch (error) {
        markUnknown();
        throw error;
      }
      const latest = useStore.getState();
      if (
        latest.taskDetailSessionById[identityKey]?.artifactWriteId !== token ||
        latest.taskDetailSessionById[identityKey]?.taskWriteOperation !== operation
      )
        return false;
      latest.updateTaskDetailSession(identity, {
        artifactWriteId: null,
        taskWriteMarkerId: null,
        taskWriteOperation: null,
      });
      return true;
    },
    [identity, identityKey, readGuardContext]
  );

  const checkGuardedTaskWriteOutcome = useCallback(
    async (operation: TaskWriteOperation): Promise<void> => {
      if (!isOriginCurrent()) throw new Error('Task context changed');
      const before = useStore.getState();
      const priorSession = before.taskDetailSessionById[identityKey];
      if (
        priorSession?.artifactOutcomeUnknown &&
        (!priorSession.taskWriteMarkerId || !priorSession.taskWriteOperation)
      )
        throw new Error('Task write safety marker is unavailable');
      if (priorSession?.taskWriteOperation && priorSession.taskWriteOperation !== operation)
        throw new Error('A different task operation requires attention');
      const expectedContext = priorSession?.taskWriteExpectedContext;
      const expectedRoot = priorSession?.taskWriteRootFingerprint;
      if (
        !expectedContext ||
        !sameGuardContext(expectedContext, expectedRoot, await readGuardContext())
      )
        throw new Error('Task data root changed');
      const revision = priorSession?.artifactOutcomeRevision ?? 0;
      const previousToken = before.taskDetailById[identityKey]?.fullToken;
      before.invalidateTaskDetailSource(identity);
      await withArtifactOutcomeDeadline(useStore.getState().ensureTaskDetail(identity));
      if (!sameGuardContext(expectedContext, expectedRoot, await readGuardContext()))
        throw new Error('Task data root changed');
      const state = useStore.getState();
      const entry = state.taskDetailById[identityKey];
      if (
        !isOriginCurrent() ||
        !entry ||
        entry.phase !== 'ready' ||
        !entry.full ||
        entry.loading ||
        entry.refreshPending ||
        !entry.fullToken ||
        (previousToken &&
          entry.fullToken.sourceEpoch === previousToken.sourceEpoch &&
          entry.fullToken.serial === previousToken.serial)
      ) {
        throw new Error('Could not confirm the current task state');
      }
      const session = state.taskDetailSessionById[identityKey];
      if (
        (session?.artifactOutcomeRevision ?? 0) !== revision ||
        (session?.taskWriteOperation && session.taskWriteOperation !== operation)
      )
        throw new Error('Task outcome changed during the check');
      if (session?.artifactOutcomeUnknown)
        state.updateTaskDetailSession(identity, { artifactOutcomeChecked: true });
    },
    [identity, identityKey, isOriginCurrent, readGuardContext]
  );

  const confirmGuardedTaskWriteOutcome = useCallback(
    async (token: string, operation: TaskWriteOperation): Promise<void> => {
      if (!isOriginCurrent()) throw new Error('Task context changed');
      const state = useStore.getState();
      const session = state.taskDetailSessionById[identityKey];
      if (
        !session?.artifactOutcomeUnknown ||
        !session.artifactOutcomeChecked ||
        session.artifactWriteId ||
        session.taskWriteMarkerId !== token ||
        session.taskWriteOperation !== operation
      )
        throw new Error('Check the matching task operation first');
      if (
        !session.taskWriteExpectedContext ||
        !sameGuardContext(
          session.taskWriteExpectedContext,
          session.taskWriteRootFingerprint,
          await readGuardContext()
        )
      )
        throw new Error('Task data root changed');
      const revision = session.artifactOutcomeRevision;
      await withArtifactOutcomeDeadline(
        taskWriteGuardStorage.release(
          {
            ...identity,
            dataRootFingerprint: session.taskWriteRootFingerprint!,
          },
          { version: 1, attemptId: token, operation },
          { allowMissingAfterDecision: true }
        )
      );
      const latest = useStore.getState();
      const current = latest.taskDetailSessionById[identityKey];
      if (
        current?.taskWriteMarkerId !== token ||
        current.taskWriteOperation !== operation ||
        current.artifactOutcomeRevision !== revision
      ) {
        latest.updateTaskDetailSession(identity, { taskWriteGuardState: 'unavailable' });
        throw new Error('Task write state changed during confirmation');
      }
      latest.updateTaskDetailSession(identity, {
        artifactOutcomeUnknown: false,
        artifactOutcomeChecked: false,
        taskWriteMarkerId: null,
        taskWriteOperation: null,
      });
    },
    [identity, identityKey, isOriginCurrent, readGuardContext]
  );

  const checkArtifactOutcome = useCallback(
    () => checkGuardedTaskWriteOutcome('artifact'),
    [checkGuardedTaskWriteOutcome]
  );
  const confirmArtifactOutcome = useCallback(async (): Promise<void> => {
    const token = useStore.getState().taskDetailSessionById[identityKey]?.taskWriteMarkerId;
    if (!token) throw new Error('Task write safety marker is unavailable');
    await confirmGuardedTaskWriteOutcome(token, 'artifact');
  }, [confirmGuardedTaskWriteOutcome, identityKey]);

  const updateTaskArtifact = useCallback(
    async (fields: TaskFieldUpdates): Promise<void> => {
      const attempt = await beginGuardedTaskWrite('artifact');
      const attemptId = attempt.token;
      try {
        await withArtifactOutcomeDeadline(
          useStore.getState().updateTaskFields(identity.teamName, identity.taskId, {
            ...fields,
            artifactExpectedContext: attempt.expectedContext,
            artifactExpectedRootFingerprint: attempt.expectedRootFingerprint,
          })
        );
        await checkGuardedTaskWriteOutcome('artifact');
        if (!(await settleGuardedTaskWrite(attemptId, 'artifact', 'confirmed')))
          throw new Error('Task write attempt changed');
      } catch (error) {
        await settleGuardedTaskWrite(attemptId, 'artifact', 'unknown');
        throw new ArtifactWriteOutcomeHandledError(
          error instanceof Error ? error.message : 'Artifact outcome unknown'
        );
      }
    },
    [beginGuardedTaskWrite, checkGuardedTaskWriteOutcome, identity, settleGuardedTaskWrite]
  );

  return {
    markArtifactOutcomeUnknown,
    checkArtifactOutcome,
    confirmArtifactOutcome,
    updateTaskArtifact,
    taskWriteGuard: {
      status: session.taskWriteGuardState ?? 'loading',
      reason: session.taskWriteGuardReason ?? null,
      activeId: session.artifactWriteId ?? null,
      markerId: session.taskWriteMarkerId ?? null,
      operation: session.taskWriteOperation ?? null,
      unknown: session.artifactOutcomeUnknown === true,
      checked: session.artifactOutcomeChecked === true,
      expectedContext: session.taskWriteExpectedContext ?? null,
      expectedRootFingerprint: session.taskWriteRootFingerprint ?? null,
    },
    beginGuardedTaskWrite,
    settleGuardedTaskWrite,
    checkGuardedTaskWriteOutcome,
    confirmGuardedTaskWriteOutcome,
  } as const;
}
