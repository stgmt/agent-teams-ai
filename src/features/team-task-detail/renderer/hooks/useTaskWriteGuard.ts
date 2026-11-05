import { useCallback, useEffect } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';

import {
  ArtifactWriteNotStartedError,
  ArtifactWriteOutcomeHandledError,
} from '../../core/domain/taskArtifactOutcome';
import {
  TaskWriteActionDecidedError,
  TaskWriteGuardOccupiedError,
  taskWriteGuardStorage,
} from '../adapters/taskWriteGuardStorage';

import { useTaskWriteFence } from './useTaskWriteFence';

import type {
  TaskDetailIdentity,
  TaskDetailSession,
  TaskWriteDecision,
  TaskWriteOperation,
} from '../../contracts';
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
                taskWriteDecision: marker.decision ?? null,
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
                taskWriteDecision: null,
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
                  taskWriteDecision: error.marker.decision ?? null,
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

  const beginGuardedTaskDecision = useCallback(
    async (actionId: string, choice: TaskWriteDecision['decision']) => {
      const state = useStore.getState();
      const session = state.taskDetailSessionById[identityKey];
      if (
        !requireOwner() ||
        session?.taskWriteGuardState !== 'ready' ||
        session.artifactWriteId ||
        !session.taskWriteRootFingerprint ||
        !session.taskWriteExpectedContext ||
        (session.artifactOutcomeUnknown &&
          (!session.artifactOutcomeChecked ||
            session.taskWriteOperation !== 'manifest' ||
            !session.taskWriteMarkerId)) ||
        session.taskWriteDecision
      ) {
        throw new ArtifactWriteNotStartedError('No task decision was sent');
      }
      const token = crypto.randomUUID();
      const decision: TaskWriteDecision = {
        actionId,
        decisionId: crypto.randomUUID(),
        decision: choice,
        stage: 'decision',
      };
      const marker = {
        version: 1 as const,
        attemptId: token,
        operation: 'manifest' as const,
        decision,
      };
      const previous = session.taskWriteMarkerId
        ? {
            version: 1 as const,
            attemptId: session.taskWriteMarkerId,
            operation: 'manifest' as const,
          }
        : null;
      state.updateTaskDetailSession(identity, { artifactWriteId: token });
      try {
        // Persist the answer before any IPC, replacing the old marker atomically.
        await withArtifactOutcomeDeadline(
          taskWriteGuardStorage.beginDecision(
            { ...identity, dataRootFingerprint: session.taskWriteRootFingerprint },
            previous,
            marker
          )
        );
      } catch (error) {
        let recordedMarker: Awaited<ReturnType<typeof taskWriteGuardStorage.read>> | undefined;
        if (error instanceof TaskWriteActionDecidedError) {
          try {
            recordedMarker = await withArtifactOutcomeDeadline(
              taskWriteGuardStorage.read({
                ...identity,
                dataRootFingerprint: session.taskWriteRootFingerprint,
              })
            );
          } catch {
            // A failed read remains unavailable; do not infer an empty guard.
          }
        }
        const latest = useStore.getState();
        if (latest.taskDetailSessionById[identityKey]?.artifactWriteId === token) {
          latest.updateTaskDetailSession(
            identity,
            error instanceof TaskWriteGuardOccupiedError
              ? {
                  artifactWriteId: null,
                  taskWriteMarkerId: error.marker.attemptId,
                  taskWriteOperation: error.marker.operation,
                  taskWriteDecision: error.marker.decision ?? null,
                  artifactOutcomeUnknown: true,
                  artifactOutcomeChecked: false,
                }
              : error instanceof TaskWriteActionDecidedError && recordedMarker !== undefined
                ? {
                    artifactWriteId: null,
                    taskWriteMarkerId: recordedMarker?.attemptId ?? null,
                    taskWriteOperation: recordedMarker?.operation ?? null,
                    taskWriteDecision: recordedMarker?.decision ?? null,
                    artifactOutcomeUnknown: recordedMarker !== null,
                    artifactOutcomeChecked: false,
                  }
                : { artifactWriteId: null, taskWriteGuardState: 'unavailable' }
          );
        }
        throw new ArtifactWriteNotStartedError(
          'Task decision safety storage is unavailable or occupied'
        );
      }
      const latest = useStore.getState();
      if (latest.taskDetailSessionById[identityKey]?.artifactWriteId === token) {
        latest.updateTaskDetailSession(identity, {
          taskWriteMarkerId: token,
          taskWriteOperation: 'manifest',
          taskWriteDecision: decision,
          artifactOutcomeUnknown: false,
          artifactOutcomeChecked: false,
        });
      }
      const context = await readGuardContext().catch(() => null);
      if (
        !context ||
        !sameGuardContext(
          session.taskWriteExpectedContext,
          session.taskWriteRootFingerprint,
          context
        ) ||
        !requireOwner() ||
        useStore.getState().taskDetailSessionById[identityKey]?.artifactWriteId !== token
      ) {
        const current = useStore.getState();
        if (current.taskDetailSessionById[identityKey]?.artifactWriteId === token)
          current.updateTaskDetailSession(identity, {
            artifactWriteId: null,
            artifactOutcomeUnknown: true,
          });
        throw new ArtifactWriteOutcomeHandledError(
          'Task decision was recorded for manual recovery'
        );
      }
      return {
        token,
        decision,
        expectedContext: connectionContext(context),
        expectedRootFingerprint: context.physicalRootFingerprint,
      };
    },
    [identity, identityKey, readGuardContext, requireOwner]
  );

  const { markGuardedDecisionFenceSent, releaseUnadmittedDecisionFence, syncManifestDecision } =
    useTaskWriteFence({
      identity,
      identityKey,
      isOriginCurrent,
      withDeadline: withArtifactOutcomeDeadline,
    });

  const readGuardedTaskDecisionIds = useCallback(async (): Promise<string[]> => {
    const current = useStore.getState().taskDetailSessionById[identityKey];
    if (
      !isOriginCurrent() ||
      !current?.taskWriteRootFingerprint ||
      !current.taskWriteExpectedContext
    )
      throw new Error('Task context is unavailable');
    const root = current.taskWriteRootFingerprint;
    const expected = current.taskWriteExpectedContext;
    const ids = await withArtifactOutcomeDeadline(
      taskWriteGuardStorage.readChosenActionIds({
        ...identity,
        dataRootFingerprint: root,
      })
    );
    if (!sameGuardContext(expected, root, await readGuardContext()))
      throw new Error('Task context changed');
    return ids;
  }, [identity, identityKey, isOriginCurrent, readGuardContext]);

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
      const adoptRecordedDecision = async (): Promise<boolean> => {
        if (!current.taskWriteRootFingerprint) return false;
        try {
          const result = await withArtifactOutcomeDeadline(
            taskWriteGuardStorage.readDecision(
              { ...identity, dataRootFingerprint: current.taskWriteRootFingerprint },
              { version: 1, attemptId: token, operation }
            )
          );
          if (!result.explicitlyResolved || result.marker?.attemptId === token) return false;
          const latest = useStore.getState();
          const session = latest.taskDetailSessionById[identityKey];
          if (
            session?.artifactWriteId !== token ||
            session.taskWriteOperation !== operation ||
            session.taskWriteMarkerId !== token
          )
            return false;
          latest.updateTaskDetailSession(identity, {
            artifactWriteId: null,
            taskWriteMarkerId: result.marker?.attemptId ?? null,
            taskWriteOperation: result.marker?.operation ?? null,
            taskWriteDecision: result.marker?.decision ?? null,
            artifactOutcomeUnknown: result.marker !== null,
            artifactOutcomeChecked: false,
            artifactOutcomeRevision: (session.artifactOutcomeRevision ?? 0) + 1,
          });
          return true;
        } catch {
          return false;
        }
      };
      if (outcome === 'unknown') {
        if (await adoptRecordedDecision()) return true;
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
        if (await adoptRecordedDecision()) return true;
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
        taskWriteDecision: null,
      });
      return true;
    },
    [identity, identityKey, readGuardContext]
  );

  const checkGuardedTaskWriteOutcome = useCallback(
    async (
      operation: TaskWriteOperation
    ): Promise<{
      expectedContext: AppConnectionContext;
      expectedRootFingerprint: string;
      manifest?: { markerId: string; decision: TaskWriteDecision | null; resolved?: true };
    }> => {
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
      let expectedContext = priorSession?.taskWriteExpectedContext;
      const expectedRoot = priorSession?.taskWriteRootFingerprint;
      const liveContext = await readGuardContext();
      if (!expectedContext || !expectedRoot) throw new Error('Task data root changed');
      if (!sameGuardContext(expectedContext, expectedRoot, liveContext)) {
        if (
          !priorSession?.artifactOutcomeUnknown ||
          priorSession.artifactWriteId ||
          !priorSession.taskWriteMarkerId ||
          expectedContext.appInstanceId !== liveContext.appInstanceId ||
          !expectedRoot ||
          expectedRoot !== liveContext.physicalRootFingerprint
        )
          throw new Error('Task data root changed');
        const stored = await withArtifactOutcomeDeadline(
          taskWriteGuardStorage.read({ ...identity, dataRootFingerprint: expectedRoot })
        );
        if (
          stored &&
          (stored.attemptId !== priorSession.taskWriteMarkerId || stored.operation !== operation)
        )
          throw new Error('Task outcome changed during the check');
        if (!sameGuardContext(liveContext, expectedRoot, await readGuardContext()))
          throw new Error('Task data root changed');
        const latest = useStore.getState();
        const session = latest.taskDetailSessionById[identityKey];
        if (
          !session?.artifactOutcomeUnknown ||
          session.artifactWriteId ||
          session.taskWriteMarkerId !== priorSession.taskWriteMarkerId ||
          session.taskWriteOperation !== operation ||
          session.artifactOutcomeRevision !== priorSession.artifactOutcomeRevision
        )
          throw new Error('Task outcome changed during the check');
        expectedContext = connectionContext(liveContext);
        latest.updateTaskDetailSession(identity, {
          taskWriteExpectedContext: expectedContext,
          artifactOutcomeChecked: false,
        });
      }
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
      let manifest:
        | { markerId: string; decision: TaskWriteDecision | null; resolved?: true }
        | undefined;
      if (operation === 'manifest' && priorSession?.artifactOutcomeUnknown) {
        if (!priorSession.taskWriteMarkerId)
          throw new Error('Task write safety marker is unavailable');
        manifest = await syncManifestDecision(
          priorSession.taskWriteMarkerId,
          expectedRoot,
          priorSession.taskWriteDecision ?? null,
          revision
        );
        if (!sameGuardContext(expectedContext, expectedRoot, await readGuardContext()))
          throw new Error('Task data root changed');
      }
      const latest = useStore.getState();
      const current = latest.taskDetailSessionById[identityKey];
      if (
        (current?.artifactOutcomeRevision ?? 0) !== revision ||
        (manifest &&
          (current?.taskWriteMarkerId !== manifest.markerId ||
            current.taskWriteRootFingerprint !== expectedRoot ||
            current.taskWriteOperation !== 'manifest'))
      )
        throw new Error('Task outcome changed during the check');
      if (manifest?.resolved) {
        // The explicit receipt refers to this exact attempt. No durable marker
        // is deleted here: a later write must still acquire its own marker.
        latest.updateTaskDetailSession(identity, {
          artifactOutcomeUnknown: false,
          artifactOutcomeChecked: false,
          artifactOutcomeRevision: revision + 1,
          taskWriteMarkerId: null,
          taskWriteOperation: null,
          taskWriteDecision: null,
        });
      } else if (current?.artifactOutcomeUnknown) {
        latest.updateTaskDetailSession(identity, { artifactOutcomeChecked: true });
      }
      return {
        expectedContext,
        expectedRootFingerprint: expectedRoot,
        ...(manifest ? { manifest } : {}),
      };
    },
    [identity, identityKey, isOriginCurrent, readGuardContext, syncManifestDecision]
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
          { explicitDecision: true }
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
        taskWriteDecision: null,
      });
    },
    [identity, identityKey, isOriginCurrent, readGuardContext]
  );

  const checkArtifactOutcome = useCallback(async () => {
    await checkGuardedTaskWriteOutcome('artifact');
  }, [checkGuardedTaskWriteOutcome]);
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
      decision: session.taskWriteDecision ?? null,
    },
    beginGuardedTaskWrite,
    beginGuardedTaskDecision,
    markGuardedDecisionFenceSent,
    releaseUnadmittedDecisionFence,
    readGuardedTaskDecisionIds,
    settleGuardedTaskWrite,
    checkGuardedTaskWriteOutcome,
    confirmGuardedTaskWriteOutcome,
  } as const;
}
