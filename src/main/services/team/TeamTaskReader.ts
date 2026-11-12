import { yieldToEventLoop } from '@main/utils/asyncYield';
import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTasksBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import * as fs from 'fs';
import * as path from 'path';

import { estimateCachedValueBytes } from './cacheMemoryEstimate';
import { listTaskTeamNames } from './consistentTaskSnapshot';
import { getTeamFsWorkerClient } from './TeamFsWorkerClient';
import { readTaskFileProjection, unescapeLiteralNewlines } from './TeamTaskReadProjection';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';

import type { TeamTask } from '@shared/types';

const logger = createLogger('Service:TeamTaskReader');
const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024;
const ALL_TASKS_CACHE_TTL_MS = 30_000;
const TASK_FILE_CACHE_MAX_ENTRIES = 512;
const TASK_FILE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TASK_FILE_CACHE_MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const TEAM_TASKS_CACHE_MAX_ENTRIES = 32;
const TEAM_TASKS_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TEAM_TASKS_CACHE_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const ALL_TASKS_CACHE_MAX_BYTES = 16 * 1024 * 1024;

interface CachedAllTasks {
  value: (TeamTask & { teamName: string })[];
  expiresAt: number;
  estimatedBytes: number;
}

interface InFlightAllTasks {
  promise: Promise<(TeamTask & { teamName: string })[]>;
  generationAtStart: number;
}

interface TaskFileSignature {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface CachedTaskFile {
  signature: TaskFileSignature;
  task: TeamTask | null;
  estimatedBytes: number;
}

interface CachedTeamTasks {
  signaturesByFile: Map<string, TaskFileSignature>;
  value: TeamTask[];
  estimatedBytes: number;
}

interface ScannedTaskFile {
  file: string;
  taskPath: string;
  signature: TaskFileSignature;
}

function cloneTasks<T>(tasks: readonly T[]): T[] {
  return structuredClone([...tasks]);
}

function buildTaskFileSignature(stat: fs.Stats): TaskFileSignature {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function taskFileSignaturesEqual(a: TaskFileSignature, b: TaskFileSignature): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}

export class TeamTaskReader {
  private static allTasksCache: CachedAllTasks | null = null;
  private static allTasksInFlight: InFlightAllTasks | null = null;
  private static allTasksGeneration = 0;
  private static taskFileCache = new Map<string, CachedTaskFile>();
  private static taskFileCacheBytes = 0;
  private static teamTasksCache = new Map<string, CachedTeamTasks>();
  private static teamTasksCacheBytes = 0;

  static invalidateAllTasksCache(): void {
    TeamTaskReader.allTasksCache = null;
    TeamTaskReader.taskFileCache.clear();
    TeamTaskReader.taskFileCacheBytes = 0;
    TeamTaskReader.teamTasksCache.clear();
    TeamTaskReader.teamTasksCacheBytes = 0;
    TeamTaskReader.allTasksGeneration += 1;
  }

  private static deleteCachedTaskFile(taskPath: string): void {
    const cached = TeamTaskReader.taskFileCache.get(taskPath);
    if (!cached) {
      return;
    }
    TeamTaskReader.taskFileCacheBytes = Math.max(
      0,
      TeamTaskReader.taskFileCacheBytes - cached.estimatedBytes
    );
    TeamTaskReader.taskFileCache.delete(taskPath);
  }

  private static evictOldestTaskFileCacheEntry(): boolean {
    const oldestKey = TeamTaskReader.taskFileCache.keys().next().value;
    if (oldestKey === undefined) {
      return false;
    }
    TeamTaskReader.deleteCachedTaskFile(oldestKey);
    return true;
  }

  private static trimTaskFileCache(): void {
    while (
      TeamTaskReader.taskFileCache.size > TASK_FILE_CACHE_MAX_ENTRIES ||
      TeamTaskReader.taskFileCacheBytes > TASK_FILE_CACHE_MAX_BYTES
    ) {
      if (!TeamTaskReader.evictOldestTaskFileCacheEntry()) {
        return;
      }
    }
  }

  private static deleteCachedTeamTasks(teamName: string): void {
    const cached = TeamTaskReader.teamTasksCache.get(teamName);
    if (!cached) {
      return;
    }
    TeamTaskReader.teamTasksCacheBytes = Math.max(
      0,
      TeamTaskReader.teamTasksCacheBytes - cached.estimatedBytes
    );
    TeamTaskReader.teamTasksCache.delete(teamName);
  }

  private static evictOldestTeamTasksCacheEntry(): boolean {
    const oldestKey = TeamTaskReader.teamTasksCache.keys().next().value;
    if (oldestKey === undefined) {
      return false;
    }
    TeamTaskReader.deleteCachedTeamTasks(oldestKey);
    return true;
  }

  private static trimTeamTasksCache(): void {
    while (
      TeamTaskReader.teamTasksCache.size > TEAM_TASKS_CACHE_MAX_ENTRIES ||
      TeamTaskReader.teamTasksCacheBytes > TEAM_TASKS_CACHE_MAX_BYTES
    ) {
      if (!TeamTaskReader.evictOldestTeamTasksCacheEntry()) {
        return;
      }
    }
  }

  private static getCachedTaskFileSnapshot(
    taskPath: string,
    signature: TaskFileSignature
  ): TeamTask | null | undefined {
    const cached = TeamTaskReader.taskFileCache.get(taskPath);
    if (!cached) {
      return undefined;
    }
    if (!taskFileSignaturesEqual(cached.signature, signature)) {
      TeamTaskReader.deleteCachedTaskFile(taskPath);
      return undefined;
    }
    TeamTaskReader.taskFileCache.delete(taskPath);
    TeamTaskReader.taskFileCache.set(taskPath, cached);
    return cached.task;
  }

  private static setCachedTaskFile(
    taskPath: string,
    signature: TaskFileSignature,
    task: TeamTask | null
  ): void {
    const estimatedBytes = task ? estimateCachedValueBytes(task) : 0;
    TeamTaskReader.deleteCachedTaskFile(taskPath);
    if (estimatedBytes > TASK_FILE_CACHE_MAX_ENTRY_BYTES) {
      return;
    }
    TeamTaskReader.taskFileCache.set(taskPath, {
      signature,
      task,
      estimatedBytes,
    });
    TeamTaskReader.taskFileCacheBytes += estimatedBytes;
    TeamTaskReader.trimTaskFileCache();
  }

  private static getCachedTeamTasks(
    teamName: string,
    scannedFiles: readonly ScannedTaskFile[]
  ): readonly TeamTask[] | null {
    const cached = TeamTaskReader.teamTasksCache.get(teamName);
    if (!cached || cached.signaturesByFile.size !== scannedFiles.length) {
      if (cached) {
        TeamTaskReader.deleteCachedTeamTasks(teamName);
      }
      return null;
    }

    for (const file of scannedFiles) {
      const cachedSignature = cached.signaturesByFile.get(file.file);
      if (!cachedSignature || !taskFileSignaturesEqual(cachedSignature, file.signature)) {
        TeamTaskReader.deleteCachedTeamTasks(teamName);
        return null;
      }
    }

    TeamTaskReader.teamTasksCache.delete(teamName);
    TeamTaskReader.teamTasksCache.set(teamName, cached);
    return cached.value;
  }

  private static setCachedTeamTasks(
    teamName: string,
    scannedFiles: readonly ScannedTaskFile[],
    tasks: TeamTask[]
  ): void {
    const estimatedBytes = estimateCachedValueBytes(tasks);
    TeamTaskReader.deleteCachedTeamTasks(teamName);
    if (estimatedBytes > TEAM_TASKS_CACHE_MAX_ENTRY_BYTES) {
      return;
    }
    TeamTaskReader.teamTasksCache.set(teamName, {
      signaturesByFile: new Map(scannedFiles.map((file) => [file.file, file.signature] as const)),
      value: tasks,
      estimatedBytes,
    });
    TeamTaskReader.teamTasksCacheBytes += estimatedBytes;
    TeamTaskReader.trimTeamTasksCache();
  }

  /**
   * Returns the next available numeric task ID by scanning ALL task files
   * (including _internal ones) to avoid ID collisions.
   */
  async getNextTaskId(teamName: string): Promise<string> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '1';
      }
      throw error;
    }

    let maxId = 0;
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const num = Number(file.replace('.json', ''));
      if (Number.isFinite(num) && num > maxId) {
        maxId = num;
      }
    }

    return String(maxId + 1);
  }

  async getTasks(teamName: string): Promise<TeamTask[]> {
    const tasks = await this.readTasksSnapshot(teamName, { compactForSnapshot: false });
    return cloneTasks(tasks);
  }

  listTaskTeamNames = listTaskTeamNames;

  async getTasksProjectionSnapshot(
    teamName: string,
    options: { fresh?: boolean } = {}
  ): Promise<readonly TeamTask[]> {
    return this.readTasksSnapshot(teamName, { compactForSnapshot: true, fresh: options.fresh });
  }

  private async readTasksSnapshot(
    teamName: string,
    options: { compactForSnapshot: boolean; fresh?: boolean }
  ): Promise<readonly TeamTask[]> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const scannedFiles: ScannedTaskFile[] = [];
    let canCacheTeamSnapshot = true;
    for (const file of entries) {
      if (
        !file.endsWith('.json') ||
        file.startsWith('.') ||
        file === '.lock' ||
        file === '.highwatermark'
      ) {
        continue;
      }

      const taskPath = path.join(tasksDir, file);
      try {
        const fileStat = await fs.promises.stat(taskPath);
        if (!fileStat.isFile() || fileStat.size > MAX_TASK_FILE_BYTES) {
          if (options.fresh) throw new Error(`Task file is unavailable or too large: ${taskPath}`);
          logger.debug(`Skipping suspicious task file: ${taskPath}`);
          TeamTaskReader.deleteCachedTaskFile(taskPath);
          TeamTaskReader.deleteCachedTeamTasks(teamName);
          canCacheTeamSnapshot = false;
          continue;
        }
        scannedFiles.push({
          file,
          taskPath,
          signature: buildTaskFileSignature(fileStat),
        });
      } catch (error) {
        if (options.fresh) throw error;
        TeamTaskReader.deleteCachedTaskFile(taskPath);
        TeamTaskReader.deleteCachedTeamTasks(teamName);
        canCacheTeamSnapshot = false;
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
    }

    const canUseProjectionCache = options.compactForSnapshot && !options.fresh;
    const cachedTeamTasks = canUseProjectionCache
      ? TeamTaskReader.getCachedTeamTasks(teamName, scannedFiles)
      : null;
    if (cachedTeamTasks) {
      return cachedTeamTasks;
    }

    const tasks: TeamTask[] = [];
    let processed = 0;
    for (const scannedFile of scannedFiles) {
      const { taskPath, signature } = scannedFile;
      try {
        const cachedTask = canUseProjectionCache
          ? TeamTaskReader.getCachedTaskFileSnapshot(taskPath, signature)
          : undefined;
        if (cachedTask !== undefined) {
          if (cachedTask) {
            tasks.push(cachedTask);
          }
          continue;
        }
        const raw = await readFileUtf8WithTimeout(taskPath, 5_000);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Skip internal CLI tracking entries (spawned subagent bookkeeping)
        const metadata = parsed.metadata as Record<string, unknown> | undefined;
        if (metadata?._internal === true) {
          if (canUseProjectionCache) {
            TeamTaskReader.setCachedTaskFile(taskPath, signature, null);
          }
          continue;
        }
        let task = readTaskFileProjection(parsed, signature);
        if (task.status === 'deleted') {
          if (canUseProjectionCache) {
            TeamTaskReader.setCachedTaskFile(taskPath, signature, null);
          }
          continue;
        }
        if (options.compactForSnapshot) {
          task = compactTeamTaskForSnapshot(task);
        }
        if (canUseProjectionCache) {
          TeamTaskReader.setCachedTaskFile(taskPath, signature, task);
        }
        tasks.push(task);
      } catch (error) {
        if (options.fresh) throw error;
        if (canUseProjectionCache) {
          TeamTaskReader.deleteCachedTaskFile(taskPath);
          TeamTaskReader.deleteCachedTeamTasks(teamName);
        }
        canCacheTeamSnapshot = false;
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
      processed++;
      if (processed % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    // Sort by display ID first for stable human-facing ordering, then canonical id.
    tasks.sort((a, b) => {
      const aLabel = a.displayId ?? a.id;
      const bLabel = b.displayId ?? b.id;
      const aIsNumeric = /^\d+$/.test(aLabel);
      const bIsNumeric = /^\d+$/.test(bLabel);
      if (aIsNumeric && bIsNumeric) return Number(aLabel) - Number(bLabel);
      if (aIsNumeric) return -1;
      if (bIsNumeric) return 1;
      const byDisplay = aLabel.localeCompare(bLabel, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (byDisplay !== 0) return byDisplay;
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
    });

    if (canUseProjectionCache && canCacheTeamSnapshot) {
      TeamTaskReader.setCachedTeamTasks(teamName, scannedFiles, tasks);
    }

    return tasks;
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    const tasksDir = path.join(getTasksBasePath(), teamName);

    let entries: string[];
    try {
      entries = await fs.promises.readdir(tasksDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const tasks: TeamTask[] = [];
    let processed = 0;
    for (const file of entries) {
      if (
        !file.endsWith('.json') ||
        file.startsWith('.') ||
        file === '.lock' ||
        file === '.highwatermark'
      ) {
        continue;
      }

      const taskPath = path.join(tasksDir, file);
      try {
        const fileStat = await fs.promises.stat(taskPath);
        if (!fileStat.isFile() || fileStat.size > MAX_TASK_FILE_BYTES) {
          logger.debug(`Skipping suspicious task file: ${taskPath}`);
          continue;
        }
        const raw = await readFileUtf8WithTimeout(taskPath, 5_000);
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Skip internal CLI tracking entries
        const metadata = parsed.metadata as Record<string, unknown> | undefined;
        if (metadata?._internal === true) {
          continue;
        }
        if (parsed.status !== 'deleted') {
          continue;
        }

        const subject = typeof parsed.subject === 'string' ? parsed.subject : '';

        const task: TeamTask = {
          id:
            typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
          displayId:
            typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
              ? parsed.displayId.trim()
              : deriveTaskDisplayId(
                  typeof parsed.id === 'string' || typeof parsed.id === 'number'
                    ? String(parsed.id)
                    : ''
                ),
          subject,
          description:
            typeof parsed.description === 'string'
              ? unescapeLiteralNewlines(parsed.description)
              : undefined,
          owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
          status: 'deleted',
          deletedAt: typeof parsed.deletedAt === 'string' ? parsed.deletedAt : undefined,
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
          reviewState: getReviewStateFromTask({
            reviewState: parsed.reviewState as TeamTask['reviewState'],
            status: 'deleted',
          }),
        };

        tasks.push(task);
      } catch {
        logger.debug(`Skipping invalid task file: ${taskPath}`);
      }
      processed++;
      if (processed % 50 === 0) {
        await yieldToEventLoop();
      }
    }

    return tasks;
  }

  async getAllTasks(): Promise<(TeamTask & { teamName: string })[]> {
    const tasks = await this.getAllTasksProjectionSnapshot();
    return cloneTasks(tasks);
  }

  async getAllTasksProjectionSnapshot(): Promise<readonly (TeamTask & { teamName: string })[]> {
    const startedAt = Date.now();
    const cached = TeamTaskReader.allTasksCache;
    if (cached && cached.expiresAt > Date.now()) {
      const ms = Date.now() - startedAt;
      if (ms >= 1500) {
        logger.warn(`[getAllTasks] cache read slow ms=${ms} tasks=${cached.value.length}`);
      }
      return cached.value;
    }

    if (TeamTaskReader.allTasksInFlight?.generationAtStart === TeamTaskReader.allTasksGeneration) {
      const waitedAt = Date.now();
      const tasks = await TeamTaskReader.allTasksInFlight.promise;
      const ms = Date.now() - startedAt;
      if (ms >= 1500) {
        logger.warn(
          `[getAllTasks] in-flight wait slow ms=${ms} waitMs=${Date.now() - waitedAt} tasks=${tasks.length}`
        );
      }
      return tasks;
    }

    const request = this.readAllTasksUncached();
    const generationAtStart = TeamTaskReader.allTasksGeneration;
    TeamTaskReader.allTasksInFlight = {
      promise: request,
      generationAtStart,
    };
    try {
      const tasks = await request;
      if (TeamTaskReader.allTasksGeneration === generationAtStart) {
        const estimatedBytes = estimateCachedValueBytes(tasks);
        TeamTaskReader.allTasksCache =
          estimatedBytes <= ALL_TASKS_CACHE_MAX_BYTES
            ? {
                value: tasks,
                expiresAt: Date.now() + ALL_TASKS_CACHE_TTL_MS,
                estimatedBytes,
              }
            : null;
      }
      const ms = Date.now() - startedAt;
      if (ms >= 1500) {
        logger.warn(`[getAllTasks] total slow ms=${ms} tasks=${tasks.length}`);
      }
      return tasks;
    } finally {
      if (TeamTaskReader.allTasksInFlight?.promise === request) {
        TeamTaskReader.allTasksInFlight = null;
      }
    }
  }

  private async readAllTasksUncached(): Promise<(TeamTask & { teamName: string })[]> {
    const worker = getTeamFsWorkerClient();
    if (worker.isAvailable()) {
      const startedAt = Date.now();
      try {
        const { tasks, diag } = await worker.getAllTasks({
          maxTaskBytes: MAX_TASK_FILE_BYTES,
        });
        const ms = Date.now() - startedAt;
        const skipReasons =
          diag && typeof diag === 'object' ? (diag as Record<string, unknown>).skipReasons : null;
        if (skipReasons && typeof skipReasons === 'object') {
          const bad =
            Number((skipReasons as Record<string, unknown>).task_parse_failed ?? 0) +
            Number((skipReasons as Record<string, unknown>).task_read_timeout ?? 0);
          if (bad > 0) {
            logger.warn(`[getAllTasks] worker skipped broken task files count=${bad}`);
          }
        }
        if (ms >= 2000) {
          logger.warn(`[getAllTasks] worker slow ms=${ms} diag=${JSON.stringify(diag)}`);
        }
        return tasks;
      } catch (error) {
        logger.warn(
          `[getAllTasks] worker failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // fall back
      }
    }

    const tasksBase = getTasksBasePath();

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(tasksBase, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const result: (TeamTask & { teamName: string })[] = [];
    let dirCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const tasks = await this.getTasksProjectionSnapshot(entry.name);
        for (const task of tasks) {
          result.push({ ...task, teamName: entry.name });
        }
      } catch {
        logger.debug(`Skipping tasks dir: ${entry.name}`);
      }
      dirCount++;
      if (dirCount % 2 === 0) {
        // Yield periodically to keep the main process responsive in worst-case directories.
        await yieldToEventLoop();
      }
    }

    return result;
  }
}
