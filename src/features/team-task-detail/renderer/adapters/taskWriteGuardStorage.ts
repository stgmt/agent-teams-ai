import { get, update } from 'idb-keyval';

import type { TaskDetailIdentity, TaskWriteDecision, TaskWriteOperation } from '../../contracts';

export interface TaskWriteGuardMarker {
  version: 1;
  attemptId: string;
  operation: TaskWriteOperation;
  decision?: TaskWriteDecision;
  fenceClaimId?: string;
}

export interface TaskWriteGuardIdentity extends TaskDetailIdentity {
  dataRootFingerprint: string;
}

export class TaskWriteGuardOccupiedError extends Error {
  constructor(public readonly marker: TaskWriteGuardMarker) {
    super('A previous task write requires attention');
  }
}

export class TaskWriteActionDecidedError extends Error {
  constructor() {
    super('This action already has a recorded decision');
  }
}

export const taskWriteGuardKey = (identity: TaskWriteGuardIdentity): string => {
  if (!/^[a-f0-9]{64}$/i.test(identity.dataRootFingerprint))
    throw new Error('Task data root fingerprint is unavailable');
  return `task-write-guard:${JSON.stringify([identity.dataRootFingerprint, identity.contextId, identity.teamName, identity.taskId])}`;
};

function parseMarker(value: unknown): TaskWriteGuardMarker | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object')
    throw new Error('Task write safety marker is unreadable');
  const marker = value as Record<string, unknown>;
  if (
    marker.version !== 1 ||
    typeof marker.attemptId !== 'string' ||
    !marker.attemptId ||
    (marker.operation !== 'artifact' && marker.operation !== 'manifest')
  ) {
    throw new Error('Task write safety marker is unreadable');
  }
  if (marker.decision !== undefined) {
    const decision = marker.decision as Partial<TaskWriteDecision> | null;
    if (
      marker.operation !== 'manifest' ||
      !decision ||
      typeof decision.actionId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(decision.actionId) ||
      typeof decision.decisionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        decision.decisionId
      ) ||
      !['completed', 'retry_once', 'leave_unresolved'].includes(decision.decision ?? '') ||
      (decision.stage !== 'decision' && decision.stage !== 'fenceSent')
    )
      throw new Error('Task write safety decision is unreadable');
  }
  if (
    marker.fenceClaimId !== undefined &&
    (typeof marker.fenceClaimId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        marker.fenceClaimId
      ) ||
      (marker.decision as TaskWriteDecision | undefined)?.stage !== 'fenceSent')
  )
    throw new Error('Task write fence claim is unreadable');
  return marker as unknown as TaskWriteGuardMarker;
}

interface GuardState {
  version: 2;
  marker: TaskWriteGuardMarker | null;
  decisions: { attemptId: string; operation: TaskWriteOperation }[];
  outcomes: { attemptId: string; operation: TaskWriteOperation; kind: 'confirmed' | 'cancelled' }[];
  chosenActions: {
    actionId: string;
    decisionId: string;
    decision: TaskWriteDecision['decision'];
  }[];
}

function parseState(value: unknown): GuardState {
  if (value === null || value === undefined)
    return { version: 2, marker: null, decisions: [], outcomes: [], chosenActions: [] };
  if (!value || typeof value !== 'object')
    throw new Error('Task write safety marker is unreadable');
  const raw = value as Record<string, unknown>;
  if (raw.version === 1)
    return {
      version: 2,
      marker: parseMarker(value),
      decisions: [],
      outcomes: [],
      chosenActions: [],
    };
  if (raw.version !== 2 || !Object.hasOwn(raw, 'marker') || !Array.isArray(raw.decisions))
    throw new Error('Task write safety marker is unreadable');
  const decisions: GuardState['decisions'] = raw.decisions.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Task write safety decision is unreadable');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.attemptId !== 'string' ||
      !item.attemptId ||
      (item.operation !== 'artifact' && item.operation !== 'manifest')
    )
      throw new Error('Task write safety decision is unreadable');
    return { attemptId: item.attemptId, operation: item.operation };
  });
  if (raw.outcomes !== undefined && !Array.isArray(raw.outcomes))
    throw new Error('Task write outcomes are unreadable');
  const outcomes: GuardState['outcomes'] = (raw.outcomes ?? []).map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Task write outcome is unreadable');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.attemptId !== 'string' ||
      !item.attemptId ||
      (item.operation !== 'artifact' && item.operation !== 'manifest') ||
      (item.kind !== 'confirmed' && item.kind !== 'cancelled')
    )
      throw new Error('Task write outcome is unreadable');
    return { attemptId: item.attemptId, operation: item.operation, kind: item.kind };
  });
  if (raw.chosenActions !== undefined && !Array.isArray(raw.chosenActions))
    throw new Error('Task action decisions are unreadable');
  const chosenActions: GuardState['chosenActions'] = (raw.chosenActions ?? []).map(
    (entry: unknown) => {
      if (!entry || typeof entry !== 'object')
        throw new Error('Task action decisions are unreadable');
      const item = entry as Record<string, unknown>;
      const probe = parseMarker({
        version: 1,
        attemptId: 'validated',
        operation: 'manifest',
        decision: { ...item, stage: 'decision' },
      });
      return {
        actionId: probe!.decision!.actionId,
        decisionId: probe!.decision!.decisionId,
        decision: probe!.decision!.decision,
      };
    }
  );
  return { version: 2, marker: parseMarker(raw.marker), decisions, outcomes, chosenActions };
}

interface GuardBackend {
  get(key: string): Promise<unknown>;
  update(key: string, change: (value: unknown) => unknown): Promise<void>;
}

export function createTaskWriteGuardStorage(
  backend: GuardBackend = {
    get: (key) => get(key),
    update: (key, change) => update(key, change),
  }
) {
  return {
    async read(identity: TaskWriteGuardIdentity): Promise<TaskWriteGuardMarker | null> {
      return parseState(await backend.get(taskWriteGuardKey(identity))).marker;
    },
    async readChosenActionIds(identity: TaskWriteGuardIdentity): Promise<string[]> {
      const state = parseState(await backend.get(taskWriteGuardKey(identity)));
      return state.chosenActions.map((item) => item.actionId);
    },
    async readDecision(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker
    ): Promise<{
      explicitlyResolved: boolean;
      confirmed?: true;
      cancelled?: true;
      marker: TaskWriteGuardMarker | null;
    }> {
      const state = parseState(await backend.get(taskWriteGuardKey(identity)));
      return {
        explicitlyResolved: state.decisions.some(
          (entry) => entry.attemptId === marker.attemptId && entry.operation === marker.operation
        ),
        ...(state.outcomes.some(
          (entry) =>
            entry.attemptId === marker.attemptId &&
            entry.operation === marker.operation &&
            entry.kind === 'confirmed'
        )
          ? { confirmed: true as const }
          : {}),
        ...(state.outcomes.some(
          (entry) =>
            entry.attemptId === marker.attemptId &&
            entry.operation === marker.operation &&
            entry.kind === 'cancelled'
        )
          ? { cancelled: true as const }
          : {}),
        marker: state.marker,
      };
    },
    async acquire(identity: TaskWriteGuardIdentity, marker: TaskWriteGuardMarker): Promise<void> {
      let occupied: TaskWriteGuardMarker | null = null;
      let resolvedAttempt = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        occupied = state.marker;
        resolvedAttempt = [...state.decisions, ...state.outcomes].some(
          (item) => item.attemptId === marker.attemptId && item.operation === marker.operation
        );
        return occupied || resolvedAttempt ? state : { ...state, marker };
      });
      if (occupied) throw new TaskWriteGuardOccupiedError(occupied);
      if (resolvedAttempt) throw new Error('Task write attempt has already been resolved');
    },
    /** Consume the old uncertainty and record the chosen answer in one transaction. */
    async beginDecision(
      identity: TaskWriteGuardIdentity,
      previous: TaskWriteGuardMarker | null,
      marker: TaskWriteGuardMarker
    ): Promise<void> {
      let occupied: TaskWriteGuardMarker | null = null;
      let decided = false;
      let resolvedAttempt = false;
      const decision = parseMarker(marker)?.decision;
      if (!decision || decision.stage !== 'decision') throw new Error('Invalid task decision');
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          current &&
          (!previous ||
            current.attemptId !== previous.attemptId ||
            current.operation !== previous.operation ||
            current.decision)
        ) {
          occupied = current;
          return state;
        }
        if (
          [...state.decisions, ...state.outcomes].some(
            (item) => item.attemptId === marker.attemptId && item.operation === marker.operation
          ) ||
          (previous?.attemptId === marker.attemptId && previous.operation === marker.operation)
        ) {
          resolvedAttempt = true;
          return state;
        }
        if (state.chosenActions.some((item) => item.actionId === decision.actionId)) {
          decided = true;
          return state;
        }
        const decisions =
          previous &&
          !state.decisions.some(
            (entry) =>
              entry.attemptId === previous.attemptId && entry.operation === previous.operation
          )
            ? [...state.decisions, { attemptId: previous.attemptId, operation: previous.operation }]
            : state.decisions;
        return {
          ...state,
          marker,
          decisions,
          chosenActions: [
            ...state.chosenActions,
            {
              actionId: decision.actionId,
              decisionId: decision.decisionId,
              decision: decision.decision,
            },
          ],
        };
      });
      if (occupied) throw new TaskWriteGuardOccupiedError(occupied);
      if (resolvedAttempt) throw new Error('Task write attempt has already been resolved');
      if (decided) throw new TaskWriteActionDecidedError();
    },
    /** Only one window may dispatch the recovery fence for this answer. */
    async markFenceSent(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker,
      claimId: string
    ): Promise<boolean> {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimId))
        throw new Error('Invalid task write fence claim');
      let claimed = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          current?.attemptId !== marker.attemptId ||
          current.operation !== 'manifest' ||
          !current.decision ||
          current.decision.actionId !== marker.decision?.actionId ||
          current.decision.decisionId !== marker.decision?.decisionId ||
          current.decision.decision !== marker.decision?.decision ||
          current.decision.stage !== 'decision'
        )
          return state;
        claimed = true;
        return {
          ...state,
          marker: {
            ...current,
            fenceClaimId: claimId,
            decision: { ...current.decision, stage: 'fenceSent' },
          },
        };
      });
      return claimed;
    },
    /** Undo only this exact claim after main confirms the service was never entered. */
    async releaseUnadmittedFence(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker,
      claimId: string
    ): Promise<boolean> {
      let released = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          current?.attemptId !== marker.attemptId ||
          current.operation !== 'manifest' ||
          current.fenceClaimId !== claimId ||
          current.decision?.stage !== 'fenceSent' ||
          current.decision.actionId !== marker.decision?.actionId ||
          current.decision.decisionId !== marker.decision?.decisionId ||
          current.decision.decision !== marker.decision?.decision
        )
          return state;
        const { fenceClaimId: _fenceClaimId, ...unclaimed } = current;
        released = true;
        return {
          ...state,
          marker: { ...unclaimed, decision: { ...current.decision, stage: 'decision' } },
        };
      });
      return released;
    },
    /** Record success and clear only the matching attempt in the same transaction. */
    async confirm(identity: TaskWriteGuardIdentity, marker: TaskWriteGuardMarker): Promise<void> {
      let confirmed = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          current?.attemptId !== marker.attemptId ||
          current.operation !== marker.operation ||
          [...state.decisions, ...state.outcomes].some(
            (item) => item.attemptId === marker.attemptId && item.operation === marker.operation
          )
        )
          return state;
        confirmed = true;
        return {
          ...state,
          marker: null,
          outcomes: [
            ...state.outcomes,
            { attemptId: marker.attemptId, operation: marker.operation, kind: 'confirmed' },
          ],
        };
      });
      if (!confirmed) throw new Error('Task write safety marker changed');
    },
    async release(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker,
      options: { explicitDecision?: boolean } = {}
    ): Promise<void> {
      let released = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          (!current && options.explicitDecision) ||
          (current?.attemptId === marker.attemptId && current.operation === marker.operation)
        ) {
          released = true;
          const alreadyRecorded = state.decisions.some(
            (entry) => entry.attemptId === marker.attemptId && entry.operation === marker.operation
          );
          const decisions =
            options.explicitDecision && !alreadyRecorded
              ? [...state.decisions, { attemptId: marker.attemptId, operation: marker.operation }]
              : state.decisions;
          const wasCurrent =
            current?.attemptId === marker.attemptId && current.operation === marker.operation;
          const outcomes =
            wasCurrent &&
            !options.explicitDecision &&
            !state.outcomes.some(
              (item) => item.attemptId === marker.attemptId && item.operation === marker.operation
            )
              ? [
                  ...state.outcomes,
                  {
                    attemptId: marker.attemptId,
                    operation: marker.operation,
                    kind: 'cancelled' as const,
                  },
                ]
              : state.outcomes;
          return { ...state, marker: null, decisions, outcomes };
        }
        return state;
      });
      if (!released) throw new Error('Task write safety marker changed');
    },
  };
}

export const taskWriteGuardStorage = createTaskWriteGuardStorage();
