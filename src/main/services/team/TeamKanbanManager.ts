import { randomUUID } from 'node:crypto';

import { atomicWriteSync } from '@main/utils/atomicWrite';
import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { KANBAN_COLUMN_IDS } from '@shared/constants/kanban';
import { createLogger } from '@shared/utils/logger';
import { createController } from 'agent-teams-controller';
import * as fs from 'fs';
import * as path from 'path';

import { ExecutionTaskStore } from './execution/ExecutionTaskStore';
import { resolveTeamSpecBindings } from './registry/TeamSpecBinding';
import { withTeamBoardLockForSyncOperation } from './boardLock';
import { TeamConfigReader } from './TeamConfigReader';

import type { KanbanColumnId, KanbanState, UpdateKanbanPatch } from '@shared/types';

const logger = createLogger('Service:TeamKanbanManager');
const MAX_KANBAN_STATE_BYTES = 512 * 1024;

function createDefaultState(teamName: string): KanbanState {
  return {
    teamName,
    reviewers: [],
    tasks: {},
  };
}

function isValidColumn(value: unknown): value is 'review' | 'approved' {
  return value === 'review' || value === 'approved';
}

function sanitizeColumnOrder(raw: unknown): KanbanState['columnOrder'] | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const result: NonNullable<KanbanState['columnOrder']> = {};
  for (const colId of KANBAN_COLUMN_IDS) {
    const arr = (raw as Record<string, unknown>)[colId];
    if (Array.isArray(arr)) {
      const ids = arr.filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        result[colId] = ids;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Validate before the tolerant projection can discard evidence used by automatic work selection. */
function validateSafetyState(value: unknown, teamName: string): void {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item);
  const invalid = (): never => {
    throw new Error('Kanban safety state is corrupt');
  };
  if (!record(value) || !record(value.tasks)) return invalid();
  if (value.revision !== undefined && typeof value.revision !== 'string') return invalid();
  if (
    value.teamName !== undefined &&
    (typeof value.teamName !== 'string' ||
      value.teamName.trim().toLowerCase() !== teamName.trim().toLowerCase())
  )
    return invalid();
  if (
    value.reviewers !== undefined &&
    (!Array.isArray(value.reviewers) ||
      value.reviewers.some((name) => typeof name !== 'string' || !name.trim()))
  )
    return invalid();
  for (const [taskId, task] of Object.entries(value.tasks)) {
    if (
      !taskId.trim() ||
      !record(task) ||
      !isValidColumn(task.column) ||
      typeof task.movedAt !== 'string' ||
      !Number.isFinite(Date.parse(task.movedAt)) ||
      (task.reviewer !== undefined &&
        task.reviewer !== null &&
        typeof task.reviewer !== 'string') ||
      (task.transitionId !== undefined && typeof task.transitionId !== 'string') ||
      (task.errorDescription !== undefined && typeof task.errorDescription !== 'string')
    )
      return invalid();
  }
  if (value.columnOrder !== undefined) {
    if (!record(value.columnOrder)) return invalid();
    for (const [column, ids] of Object.entries(value.columnOrder)) {
      if (
        !KANBAN_COLUMN_IDS.includes(column as KanbanColumnId) ||
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string')
      )
        return invalid();
    }
  }
}

export class TeamKanbanManager {
  private readonly configReader = new TeamConfigReader();
  private readonly executionTaskStore = new ExecutionTaskStore();

  private async taskAuthority(teamName: string): Promise<'local' | 'registry'> {
    const state = await this.configReader.getRegistryBindingState(teamName);
    if (state.status !== 'verified') {
      throw new Error(`Cannot verify task authority for team "${teamName}"`);
    }
    const binding = state.binding;
    const registryBacked =
      resolveTeamSpecBindings(binding, teamName).length > 0 ||
      (typeof binding.registryTeamId === 'string' && binding.registryTeamId.trim().length > 0) ||
      (typeof binding.registryRegistrationRequestId === 'string' &&
        binding.registryRegistrationRequestId.trim().length > 0) ||
      binding.registryRegistrationCompleted === false;
    return registryBacked ? 'registry' : 'local';
  }

  private assertNoPendingExecutionTransitions(teamName: string): void {
    for (const task of this.executionTaskStore.list(teamName)) {
      if (Object.prototype.hasOwnProperty.call(task, 'pendingKanbanTransition')) {
        const transition =
          task.pendingKanbanTransition?.kind === 'status' ? 'Task status' : 'Review';
        throw Object.assign(
          new Error(
            `KANBAN_TRANSITION_UNCERTAIN: ${transition} transition for task ${task.taskId} has an unknown outcome; inspect the task and board before further changes.`
          ),
          { code: 'KANBAN_TRANSITION_UNCERTAIN', taskId: task.taskId }
        );
      }
    }
  }

  private async checkedState(
    teamName: string,
    state: KanbanState,
    observedRaw: string | null | undefined
  ): Promise<KanbanState> {
    const authority = await this.taskAuthority(teamName);
    const teamDir = path.join(getTeamsBasePath(), teamName);
    return withTeamBoardLockForSyncOperation(
      { teamDir, claudeDir: path.dirname(getTeamsBasePath()) },
      () => {
        this.assertNoPendingExecutionTransitions(teamName);
        if (authority === 'local') {
          createController({
            teamName,
            claudeDir: path.dirname(getTeamsBasePath()),
            localTaskBoard: true,
          }).kanban.assertKanbanStateConsistent(state);
        }
        if (observedRaw !== undefined) {
          let currentRaw: string | null;
          try {
            currentRaw = fs.readFileSync(this.getStatePath(teamName), 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            currentRaw = null;
          }
          if (currentRaw !== observedRaw) {
            throw Object.assign(
              new Error(
                'KANBAN_SNAPSHOT_CHANGED: Kanban changed while being read; open the team again.'
              ),
              {
                code: 'KANBAN_SNAPSHOT_CHANGED',
              }
            );
          }
        }
        return state;
      },
      { createParent: false }
    );
  }

  async getState(teamName: string, _options: { strict?: boolean } = {}): Promise<KanbanState> {
    const statePath = this.getStatePath(teamName);

    let raw: string;
    let observed = false;
    try {
      const stat = await fs.promises.stat(statePath);
      observed = true;
      if (!stat.isFile() || stat.size > MAX_KANBAN_STATE_BYTES) {
        throw new Error('Kanban safety state is unavailable');
      }
      raw = await readFileUtf8WithTimeout(statePath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !observed) {
        return this.checkedState(teamName, createDefaultState(teamName), null);
      }
      await this.checkedState(teamName, createDefaultState(teamName), undefined);
      throw error;
    }

    let parsed: Partial<KanbanState>;
    try {
      parsed = JSON.parse(raw) as Partial<KanbanState>;
    } catch {
      throw new Error('Kanban safety state is corrupt');
    }
    validateSafetyState(parsed, teamName);
    const sanitizedTasks: KanbanState['tasks'] = {};
    if (parsed.tasks && typeof parsed.tasks === 'object') {
      for (const [taskId, value] of Object.entries(parsed.tasks)) {
        if (!value || typeof value !== 'object') {
          continue;
        }

        const candidate = value as Partial<KanbanState['tasks'][string]>;
        if (!isValidColumn(candidate.column) || typeof candidate.movedAt !== 'string') {
          continue;
        }

        sanitizedTasks[taskId] = {
          column: candidate.column,
          movedAt: candidate.movedAt,
          transitionId:
            typeof candidate.transitionId === 'string' ? candidate.transitionId : undefined,
          reviewer:
            typeof candidate.reviewer === 'string' || candidate.reviewer === null
              ? candidate.reviewer
              : undefined,
          errorDescription:
            typeof candidate.errorDescription === 'string' ? candidate.errorDescription : undefined,
        };
      }
    }

    return this.checkedState(
      teamName,
      {
        teamName,
        ...(typeof parsed.revision === 'string' ? { revision: parsed.revision } : {}),
        reviewers: Array.isArray(parsed.reviewers)
          ? parsed.reviewers.filter(
              (r): r is string => typeof r === 'string' && r.trim().length > 0
            )
          : [],
        tasks: sanitizedTasks,
        columnOrder: sanitizeColumnOrder(parsed.columnOrder),
      },
      raw
    );
  }

  async updateColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    await this.mutateState(teamName, (state) => {
      const columnOrder = { ...state.columnOrder };
      if (orderedTaskIds.length > 0) columnOrder[columnId] = orderedTaskIds;
      else delete columnOrder[columnId];
      state.columnOrder = columnOrder;
      return true;
    });
  }

  async updateTask(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    if (patch.op === 'inspect_pending' || patch.op === 'resolve_pending') {
      throw new Error('Kanban recovery must use the controller');
    }
    await this.mutateState(teamName, (state) => {
      if (patch.op === 'remove' || patch.op === 'request_changes') {
        delete state.tasks[taskId];
      } else if (patch.column === 'review') {
        state.tasks[taskId] = {
          column: 'review',
          reviewer: null,
          movedAt: new Date().toISOString(),
        };
      } else {
        state.tasks[taskId] = { column: 'approved', movedAt: new Date().toISOString() };
      }
      return true;
    });
  }

  async garbageCollect(teamName: string, validTaskIds: Set<string>): Promise<void> {
    await this.mutateState(teamName, (state) => {
      const before = Object.keys(state.tasks).length;

      for (const taskId of Object.keys(state.tasks)) {
        if (!validTaskIds.has(taskId)) {
          delete state.tasks[taskId];
        }
      }

      let columnOrderChanged = false;
      if (state.columnOrder) {
        const cleaned: NonNullable<KanbanState['columnOrder']> = {};
        for (const [colId, ids] of Object.entries(state.columnOrder)) {
          const valid = ids.filter((id) => validTaskIds.has(id));
          if (valid.length > 0) {
            cleaned[colId as KanbanColumnId] = valid;
          }
          if (valid.length !== ids.length) {
            columnOrderChanged = true;
          }
        }
        if (columnOrderChanged) {
          state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
        }
      }

      const after = Object.keys(state.tasks).length;
      const tasksChanged = before !== after;
      if (!tasksChanged && !columnOrderChanged) {
        return false;
      }

      if (tasksChanged) {
        logger.debug(`Removed ${before - after} stale kanban entries for team ${teamName}`);
      }
      return true;
    });
  }

  private getStatePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'kanban-state.json');
  }

  private async mutateState(
    teamName: string,
    update: (state: KanbanState) => boolean
  ): Promise<void> {
    const authority = await this.taskAuthority(teamName);
    const teamDir = path.join(getTeamsBasePath(), teamName);
    await withTeamBoardLockForSyncOperation(
      { teamDir, claudeDir: path.dirname(getTeamsBasePath()) },
      () => {
        const statePath = this.getStatePath(teamName);
        let raw: string;
        try {
          raw = fs.readFileSync(statePath, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          raw = JSON.stringify(createDefaultState(teamName));
        }
        if (Buffer.byteLength(raw, 'utf8') > MAX_KANBAN_STATE_BYTES) {
          throw new Error('Kanban safety state is unavailable');
        }
        const parsed: unknown = JSON.parse(raw);
        validateSafetyState(parsed, teamName);
        this.assertNoPendingExecutionTransitions(teamName);
        const state =
          authority === 'local'
            ? (createController({
                teamName,
                claudeDir: path.dirname(getTeamsBasePath()),
                localTaskBoard: true,
              }).kanban.readKanbanStateAlreadyLocked() as KanbanState)
            : {
                ...(parsed as KanbanState),
                teamName,
                reviewers: (parsed as KanbanState).reviewers ?? [],
              };
        if (update(state)) this.writeState(teamName, state);
      }
    );
  }

  private writeState(teamName: string, state: KanbanState): void {
    const statePath = this.getStatePath(teamName);
    const payload: KanbanState = {
      teamName,
      revision: randomUUID(),
      reviewers: state.reviewers,
      tasks: state.tasks,
      ...(state.columnOrder && Object.keys(state.columnOrder).length > 0
        ? { columnOrder: state.columnOrder }
        : {}),
    };
    atomicWriteSync(statePath, JSON.stringify(payload, null, 2));
  }
}
