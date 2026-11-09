import { createHash, randomUUID } from 'node:crypto';

import { validateExecutionTaskPatch } from '../execution/ExecutionTaskStore';

import { REGISTRY_TASK_STATUSES } from './RegistryTaskClientTypes';
import { RegistryTaskClientError, RegistryTaskWriteRefusedError } from './RegistryTaskClientErrors';
import {
  allocateLocalId,
  normalizeTaskIds,
  registryTaskId,
  taskRefs,
  TEAM_TO_REGISTRY_STATUS,
} from './RegistryTaskIdentity';
import { executionFields, registryTaskToTeamTask } from './RegistryTeamTaskProjection';
import { RegistryTeamTaskWriteError, toTypedWriteError } from './RegistryTeamTaskWriteErrors';

import type { ExecutionTaskStore } from '../execution/ExecutionTaskStore';
import type {
  TaskCreationJournal,
  TaskCreationJournalEntry,
} from '../execution/TaskCreationJournal';
import type {
  RegistryTask,
  RegistryTaskWriteResult,
  UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
import type {
  RegistryTeamTaskClientPort,
  RegistryTeamTaskCreateInput,
  RegistryTaskGenesisSigner,
} from './RegistryTeamTaskWriter';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { RegistryRegistrationIdentity } from '@shared/types';
import type { TaskHistoryEvent, TeamTask } from '@shared/types';

interface RegistryTeamTaskCreatorDependencies {
  teamName: string;
  teamId: string;
  binding: TeamSpecBinding;
  client: Pick<
    RegistryTeamTaskClientPort,
    | 'readTasksDocumentSha'
    | 'listTasks'
    | 'confirmTaskCreation'
    | 'upsertTask'
    | 'replayTaskGenesisRequest'
  >;
  executionStore: Pick<ExecutionTaskStore, 'read' | 'write'>;
  expectedRegistrationIdentity?: RegistryRegistrationIdentity;
  signTaskGenesisAttestation?: RegistryTaskGenesisSigner;
  clock: () => Date;
  journal: TaskCreationJournal;
  readCanonicalTask(taskId: string, options: { force?: boolean }): Promise<RegistryTask>;
  invalidateListingCache(): void;
}

/** Owns task creation receipts, idempotent replay, and local creation records. */
export class RegistryTeamTaskCreator {
  readonly #dependencies: RegistryTeamTaskCreatorDependencies;

  constructor(dependencies: RegistryTeamTaskCreatorDependencies) {
    this.#dependencies = dependencies;
  }

  prepareTask(
    input: RegistryTeamTaskCreateInput,
    beforeCreate?: () => Promise<void>
  ): () => Promise<{ task: TeamTask; createdInAttempt: boolean }> {
    const { teamName, teamId, binding, client, executionStore, clock, journal } =
      this.#dependencies;
    const requirements = [...new Set((input.requirements ?? []).map((id) => id.trim()))].filter(
      Boolean
    );
    if (requirements.length === 0) {
      throw new RegistryTeamTaskWriteError(
        'REQUIREMENTS_REQUIRED',
        'Tasks of a spec-registry team must name the requirements they implement (FR/NFR/AC ids).',
        { details: { spec: binding.spec } }
      );
    }
    const requestedStatus =
      input.status ?? (input.startImmediately && input.owner ? 'in_progress' : 'pending');
    if (requestedStatus === 'deleted') {
      throw new RegistryTeamTaskWriteError(
        'STATUS_UNSUPPORTED',
        'A new task cannot start deleted.'
      );
    }
    const status = TEAM_TO_REGISTRY_STATUS[requestedStatus];
    const executionPatch = validateExecutionTaskPatch(input.executionPatch ?? {});
    const requirement = executionPatch.artifactRequirement;
    if (requestedStatus === 'completed' && requirement?.required === true) {
      throw new RegistryTeamTaskWriteError(
        'STATUS_UNSUPPORTED',
        'A new required-artifact task cannot start completed; use the completion attestation flow.'
      );
    }
    const {
      commandIdempotencyKey,
      commandId,
      projectPath: _derivedProjectPath,
      ...payload
    } = input;
    const key = commandIdempotencyKey?.trim() || randomUUID();
    const identity = commandId?.trim() || key;
    const scopedKey = JSON.stringify([binding.project, binding.spec, key]);
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...payload,
          requirements: [...requirements].sort(),
          blockedBy: normalizeTaskIds(input.blockedBy),
          related: normalizeTaskIds(input.related),
        })
      )
      .digest('hex');
    const finishLocalCreation = (entry: TaskCreationJournalEntry): void => {
      if (!entry.creationToken || !entry.createdAt || !entry.eventId) {
        throw new RegistryTeamTaskWriteError(
          'CREATION_OUTCOME_UNKNOWN',
          'The task creation has no recoverable receipt.',
          { taskId: entry.taskId }
        );
      }
      const executionId = registryTaskId({ ...binding, localId: entry.taskId });
      const existing = executionStore.read(teamName, executionId);
      if (existing) {
        if (!existing.historyEvents.some((event) => event.id === entry.eventId)) {
          throw new RegistryTeamTaskWriteError(
            'CREATION_OUTCOME_UNKNOWN',
            'Existing local task history cannot be attributed to this creation.',
            { taskId: entry.taskId }
          );
        }
        return;
      }
      const createdEvent: TaskHistoryEvent = {
        id: entry.eventId,
        timestamp: entry.createdAt,
        type: 'task_created',
        status: requestedStatus,
        actor: input.actor ?? 'user',
      };
      executionStore.write(teamName, executionId, {
        createdBy: input.actor ?? 'user',
        groupChatId: input.groupChatId,
        descriptionTaskRefs: input.descriptionTaskRefs,
        prompt: input.prompt,
        promptTaskRefs: input.promptTaskRefs,
        projectPath: entry.projectPath,
        workIntervals: requestedStatus === 'in_progress' ? [{ startedAt: entry.createdAt }] : [],
        ...executionPatch,
        historyEvents: executionPatch.historyEvents?.some((event) => event.type === 'task_created')
          ? executionPatch.historyEvents
          : [createdEvent, ...(executionPatch.historyEvents ?? [])],
      });
    };
    const buildUpsertInput = (
      localId: string,
      expectedSha: string,
      requestId: string,
      creationToken: string
    ): UpsertRegistryTaskInput => ({
      project: binding.project,
      spec: binding.spec,
      teamId,
      localId,
      title: input.subject.trim(),
      requirements,
      ...(input.description !== undefined ? { description: input.description } : {}),
      creationToken,
      status,
      ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
      ...(input.tracking?.trim() ? { tracking: input.tracking.trim() } : {}),
      expectedSha,
      requestId,
      dependsOn: taskRefs(binding.spec, input.blockedBy),
      refs: taskRefs(binding.spec, input.related),
    });
    const submitUpsert = async (
      upsertInput: UpsertRegistryTaskInput,
      entry: TaskCreationJournalEntry,
      entries: TaskCreationJournalEntry[],
      save: () => void
    ): Promise<RegistryTaskWriteResult> => {
      const result = await client.upsertTask(upsertInput);
      if (result.outcome === 'CHALLENGE_REQUIRED') {
        throw new RegistryTeamTaskWriteError(
          'CREATION_OUTCOME_UNKNOWN',
          'The registry requested a signed creation challenge; the reserved request requires reconciliation.',
          { taskId: entry.taskId }
        );
      }
      if (result.outcome === 'REFUSED') {
        if (entry.genesisReplay) {
          throw new RegistryTeamTaskWriteError(
            'CREATION_OUTCOME_UNKNOWN',
            'The signed GENESIS request has no confirmed lifecycle receipt.',
            { taskId: entry.taskId }
          );
        }
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        save();
        throw new RegistryTeamTaskWriteError(
          'REGISTRY_REFUSED',
          `The spec registry refused to create task #${entry.taskId}: ${result.refusal?.message ?? 'no reason given'}`,
          {
            taskId: entry.taskId,
            details: { registryCode: result.refusal?.code ?? null },
          }
        );
      }
      if (result.outcome !== 'APPLIED') {
        throw new RegistryTeamTaskWriteError(
          'CREATION_OUTCOME_UNKNOWN',
          'The registry did not confirm creation of a new task; reconcile the reserved task id.',
          { taskId: entry.taskId }
        );
      }
      return result;
    };
    return () =>
      journal.run(async (entries, save) => {
        const matches = entries.filter(
          (entry) => entry.key === scopedKey || entry.commandId === identity
        );
        if (matches.length > 0) {
          const existing = matches[0];
          if (
            matches.length !== 1 ||
            existing.key !== scopedKey ||
            existing.commandId !== identity ||
            existing.payloadHash !== payloadHash
          ) {
            throw new RegistryTeamTaskWriteError(
              'IDEMPOTENCY_CONFLICT',
              'Task creation command conflicts with an existing command.'
            );
          }
          if (
            existing.genesisReplay ||
            (existing.state !== 'committed' &&
              existing.creationProtocol !== 'unsigned-local-artifact-v1')
          ) {
            throw new RegistryTeamTaskWriteError(
              'CREATION_OUTCOME_UNKNOWN',
              'A previous creation may have used a different request; preserve and reconcile its journal.',
              { taskId: existing.taskId }
            );
          }
          if (existing.state !== 'committed') {
            if (!existing.creationToken) {
              throw new RegistryTeamTaskWriteError(
                'CREATION_OUTCOME_UNKNOWN',
                'The previous task creation has no recoverable receipt.',
                { taskId: existing.taskId }
              );
            }
            let current: RegistryTask;
            try {
              const confirmed = await client.confirmTaskCreation({
                ...binding,
                entity: existing.taskId,
                creationToken: existing.creationToken,
              });
              if (!confirmed) {
                throw new Error('The authoritative branch does not confirm the creation.');
              }
              current = await this.#dependencies.readCanonicalTask(existing.taskId, {
                force: true,
              });
            } catch (cause) {
              throw new RegistryTeamTaskWriteError(
                'CREATION_OUTCOME_UNKNOWN',
                'The registry cannot confirm the previous creation.',
                { taskId: existing.taskId, cause }
              );
            }
            if (current.creationToken !== existing.creationToken) {
              throw new RegistryTeamTaskWriteError(
                'CREATION_OUTCOME_UNKNOWN',
                'The current task does not match its creation receipt.',
                { taskId: existing.taskId }
              );
            }
            finishLocalCreation(existing);
            const index = entries.indexOf(existing);
            if (index >= 0) {
              const committed = { ...existing, state: 'committed' as const };
              entries[index] = committed;
            }
            save();
            return {
              task: registryTaskToTeamTask(current, binding, teamName, executionStore),
              createdInAttempt: false,
            };
          }
          const current = await this.#dependencies.readCanonicalTask(existing.taskId, {
            force: true,
          });
          return {
            task: registryTaskToTeamTask(current, binding, teamName, executionStore),
            createdInAttempt: false,
          };
        }
        await beforeCreate?.();

        const expectedSha = await client.readTasksDocumentSha(binding);
        // Local ids belong to the whole spec, not just this team's board.
        const tasks = await client.listTasks({
          ...binding,
          statuses: [...REGISTRY_TASK_STATUSES],
        });
        const allocated = allocateLocalId(tasks, binding);
        const reservedMax = entries.reduce((max, entry) => Math.max(max, Number(entry.taskId)), 0);
        const localId = String(Math.max(Number(allocated), reservedMax + 1));
        const createdAt = clock().toISOString();
        const requestId = randomUUID();
        const creationToken = `${randomUUID()}.${payloadHash}`;
        const entry: TaskCreationJournalEntry = {
          key: scopedKey,
          commandId: identity,
          payloadHash,
          taskId: localId,
          state: 'pending',
          creationProtocol: 'unsigned-local-artifact-v1',
          requestId,
          creationToken,
          expectedSha,
          createdAt,
          eventId:
            executionPatch.historyEvents?.find((event) => event.type === 'task_created')?.id ??
            randomUUID(),
          ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
        };
        entries.push(entry);
        save();
        try {
          await submitUpsert(
            buildUpsertInput(localId, expectedSha, requestId, creationToken),
            entry,
            entries,
            save
          );
        } catch (error) {
          if (error instanceof RegistryTeamTaskWriteError) throw error;
          if (entry.genesisReplay) {
            throw new RegistryTeamTaskWriteError(
              'CREATION_OUTCOME_UNKNOWN',
              'A signed GENESIS request may have reached the registry; reconcile its exact receipt.',
              { taskId: localId, cause: error }
            );
          }
          if (error instanceof RegistryTaskClientError && error.operation === 'listTools') {
            entries.pop();
            save();
            throw toTypedWriteError(error, 'upsertTask', localId);
          }
          if (
            error instanceof RegistryTaskClientError &&
            error.registryCode === 'TEAM_REQUIREMENT_INVALID'
          ) {
            // The registry checks requirement ownership before applying any write.
            entries.pop();
            save();
            throw new RegistryTeamTaskWriteError(
              'REGISTRY_REFUSED',
              `The spec registry refused to create task #${localId}: ${error.message}`,
              { taskId: localId, details: { registryCode: error.registryCode }, cause: error }
            );
          }
          if (error instanceof RegistryTaskClientError && error.registryCode === 'CONFLICT') {
            entries.pop();
            save();
            throw new RegistryTeamTaskWriteError(
              'REGISTRY_REFUSED',
              'Task creation conflicted with a concurrent registry edit; read the board and retry.',
              { taskId: localId, details: { registryCode: 'CONFLICT' }, cause: error }
            );
          }
          if (error instanceof RegistryTaskWriteRefusedError) {
            entries.pop();
            save();
            throw toTypedWriteError(error, 'upsertTask', localId);
          }
          throw new RegistryTeamTaskWriteError(
            'CREATION_OUTCOME_UNKNOWN',
            'The task creation may have reached the registry. Reconcile it before retrying.',
            { taskId: localId, cause: error }
          );
        }
        this.#dependencies.invalidateListingCache();
        try {
          finishLocalCreation(entry);
          const committed = { ...entry, state: 'committed' as const };
          entries[entries.length - 1] = committed;
          save();
        } catch (error) {
          throw new RegistryTeamTaskWriteError(
            'CREATION_OUTCOME_UNKNOWN',
            'The registry accepted the task but its local execution receipt could not be saved.',
            { taskId: localId, cause: error }
          );
        }
        const taskId = registryTaskId({ ...binding, localId });
        const task: TeamTask = {
          id: taskId,
          displayId: taskId.slice('registry-'.length, 'registry-'.length + 12),
          specProject: binding.project,
          specSlug: binding.spec,
          registryLocalId: `TASK-${localId}`,
          registryStatus: status,
          subject: input.subject.trim(),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
          status: requestedStatus,
          ...(input.blockedBy?.length ? { blockedBy: normalizeTaskIds(input.blockedBy) } : {}),
          ...(input.related?.length ? { related: normalizeTaskIds(input.related) } : {}),
          createdAt,
        };
        return {
          task: { ...task, ...executionFields(executionStore, teamName, binding, localId) },
          createdInAttempt: true,
        };
      });
  }
}
