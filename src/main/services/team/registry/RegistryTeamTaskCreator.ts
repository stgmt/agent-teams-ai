import { createHash, randomUUID } from 'node:crypto';

import { validateExecutionTaskPatch } from '../execution/ExecutionTaskStore';

import { RegistryTaskClientError, RegistryTaskWriteRefusedError } from './RegistryTaskClientErrors';
import {
  allocateLocalId,
  normalizeTaskIds,
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
import type { RegistryTask } from './RegistryTaskClientTypes';
import type {
  RegistryTeamTaskClientPort,
  RegistryTeamTaskCreateInput,
} from './RegistryTeamTaskWriter';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { TaskHistoryEvent, TeamTask } from '@shared/types';

interface RegistryTeamTaskCreatorDependencies {
  teamName: string;
  binding: TeamSpecBinding;
  client: Pick<
    RegistryTeamTaskClientPort,
    'readTasksDocumentSha' | 'confirmTaskCreation' | 'upsertTask'
  >;
  executionStore: Pick<ExecutionTaskStore, 'read' | 'write'>;
  clock: () => Date;
  journal: TaskCreationJournal;
  listTasks(force?: boolean): Promise<RegistryTask[]>;
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
    const { teamName, binding, client, executionStore, clock, journal } = this.#dependencies;
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
      const existing = executionStore.read(teamName, entry.taskId);
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
      executionStore.write(teamName, entry.taskId, {
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
            entries[entries.indexOf(existing)] = { ...existing, state: 'committed' };
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
        const tasks = await this.#dependencies.listTasks(true);
        const allocated = allocateLocalId(tasks, binding);
        const reservedMax = entries.reduce((max, entry) => Math.max(max, Number(entry.taskId)), 0);
        const localId = String(Math.max(Number(allocated), reservedMax + 1));
        const createdAt = clock().toISOString();
        const entry: TaskCreationJournalEntry = {
          key: scopedKey,
          commandId: identity,
          payloadHash,
          taskId: localId,
          state: 'pending',
          creationToken: `${randomUUID()}.${payloadHash}`,
          createdAt,
          eventId:
            executionPatch.historyEvents?.find((event) => event.type === 'task_created')?.id ??
            randomUUID(),
          ...(input.projectPath === undefined ? {} : { projectPath: input.projectPath }),
        };
        entries.push(entry);
        save();
        try {
          const result = await client.upsertTask({
            project: binding.project,
            spec: binding.spec,
            localId,
            title: input.subject.trim(),
            requirements,
            ...(input.description !== undefined ? { description: input.description } : {}),
            creationToken: entry.creationToken,
            status,
            ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
            ...(input.tracking?.trim() ? { tracking: input.tracking.trim() } : {}),
            expectedSha,
            dependsOn: taskRefs(binding.spec, input.blockedBy),
            refs: taskRefs(binding.spec, input.related),
          });
          if (result.outcome === 'REFUSED') {
            entries.pop();
            save();
            throw new RegistryTeamTaskWriteError(
              'REGISTRY_REFUSED',
              `The spec registry refused to create task #${localId}: ${result.refusal?.message ?? 'no reason given'}`,
              {
                taskId: localId,
                details: { registryCode: result.refusal?.code ?? null },
              }
            );
          }
          if (result.outcome !== 'APPLIED') {
            throw new RegistryTeamTaskWriteError(
              'CREATION_OUTCOME_UNKNOWN',
              'The registry did not confirm creation of a new task; reconcile the reserved task id.',
              { taskId: localId }
            );
          }
        } catch (error) {
          if (error instanceof RegistryTeamTaskWriteError) throw error;
          if (error instanceof RegistryTaskClientError && error.operation === 'listTools') {
            entries.pop();
            save();
            throw toTypedWriteError(error, 'upsertTask', localId);
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
          entries[entries.length - 1] = { ...entry, state: 'committed' };
          save();
        } catch (error) {
          throw new RegistryTeamTaskWriteError(
            'CREATION_OUTCOME_UNKNOWN',
            'The registry accepted the task but its local execution receipt could not be saved.',
            { taskId: localId, cause: error }
          );
        }
        const task: TeamTask = {
          id: localId,
          displayId: localId,
          subject: input.subject.trim(),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
          status: requestedStatus,
          ...(input.blockedBy?.length ? { blockedBy: normalizeTaskIds(input.blockedBy) } : {}),
          ...(input.related?.length ? { related: normalizeTaskIds(input.related) } : {}),
          createdAt,
        };
        return {
          task: { ...task, ...executionFields(executionStore, teamName, localId) },
          createdInAttempt: true,
        };
      });
  }
}
