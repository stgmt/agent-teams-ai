import type { AppStartupMemorySnapshot, AppStartupStatus, AppStartupStep } from '@shared/types';

export interface StartupStatusTrackerDeps {
  readonly startedAt: number;
  readonly captureMemory: () => AppStartupMemorySnapshot;
  readonly formatMemory: (memory: AppStartupMemorySnapshot) => string;
  readonly logInfo: (message: string) => void;
  readonly sendProgress: (status: AppStartupStatus) => void;
}

export interface StartupStatusTracker {
  publishStartupStatus(update: Partial<AppStartupStatus>): void;
  getStartupStatus(): AppStartupStatus;
}

export function createStartupStatusTracker(deps: StartupStatusTrackerDeps): StartupStatusTracker {
  const initialMemory = deps.captureMemory();
  let startupSteps: AppStartupStep[] = [
    {
      phase: 'boot',
      message: 'Starting Agent Teams AI...',
      startedAt: deps.startedAt,
      updatedAt: deps.startedAt,
      memoryAtStart: initialMemory,
    },
  ];
  let startupStatus: AppStartupStatus = {
    phase: 'boot',
    message: 'Starting Agent Teams AI...',
    ready: false,
    error: null,
    startedAt: deps.startedAt,
    updatedAt: deps.startedAt,
    memory: initialMemory,
    steps: startupSteps,
  };

  function cloneStartupSteps(): AppStartupStep[] {
    return startupSteps.map((step) => ({ ...step }));
  }

  function updateStartupTimeline(
    update: Partial<AppStartupStatus>,
    now: number,
    memory: AppStartupMemorySnapshot
  ): void {
    if (!update.phase && !update.message) {
      return;
    }

    const phase = update.phase ?? startupStatus.phase;
    const message = update.message ?? startupStatus.message;
    const current = startupSteps[startupSteps.length - 1];

    if (current?.phase !== phase) {
      if (current && !current.finishedAt) {
        current.finishedAt = now;
        current.durationMs = now - current.startedAt;
        current.updatedAt = now;
        current.memoryAtEnd = memory;
      }
      startupSteps.push({
        phase,
        message,
        startedAt: now,
        updatedAt: now,
        memoryAtStart: memory,
      });
      if (startupSteps.length > 32) {
        startupSteps = startupSteps.slice(-32);
      }
    } else {
      current.message = message;
      current.updatedAt = now;
    }
  }

  function finishCurrentStartupStep(now: number, memory: AppStartupMemorySnapshot): void {
    const current = startupSteps[startupSteps.length - 1];
    if (!current || current.finishedAt) {
      return;
    }
    current.finishedAt = now;
    current.durationMs = now - current.startedAt;
    current.updatedAt = now;
    current.memoryAtEnd = memory;
  }

  function publishStartupStatus(update: Partial<AppStartupStatus>): void {
    const now = Date.now();
    const memory = deps.captureMemory();
    updateStartupTimeline(update, now, memory);
    if (update.ready === true || update.error) {
      finishCurrentStartupStep(now, memory);
    }
    startupStatus = {
      ...startupStatus,
      ...update,
      updatedAt: now,
      memory,
      steps: cloneStartupSteps(),
    };
    if (update.phase || update.ready === true || update.error) {
      deps.logInfo(
        `[startup] phase=${startupStatus.phase} ready=${startupStatus.ready} elapsedMs=${
          now - deps.startedAt
        } ${deps.formatMemory(memory)}`
      );
    }
    deps.sendProgress(startupStatus);
  }

  return {
    publishStartupStatus,
    getStartupStatus: () => startupStatus,
  };
}
