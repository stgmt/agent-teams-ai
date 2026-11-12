import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type TaskDetailFileLinkIntent,
  type TaskDetailIdentity,
  taskDetailKey,
  useTaskDetailSession,
} from '@features/team-task-detail/renderer';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';

import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

type TaskDetailDialogComponent = typeof import('./dialogs/TaskDetailDialog').TaskDetailDialog;
let loadedTaskDetailDialogComponent: TaskDetailDialogComponent | null = null;
let taskDetailDialogImportPromise: Promise<{ default: TaskDetailDialogComponent }> | null = null;
function loadTaskDetailDialog(): Promise<{ default: TaskDetailDialogComponent }> {
  taskDetailDialogImportPromise ??= import('./dialogs/TaskDetailDialog')
    .then((m) => {
      loadedTaskDetailDialogComponent = m.TaskDetailDialog;
      return { default: m.TaskDetailDialog };
    })
    .catch((error) => {
      taskDetailDialogImportPromise = null;
      throw error;
    });
  return taskDetailDialogImportPromise;
}
export function preloadTaskDetailDialog(): void {
  void loadTaskDetailDialog().catch(() => undefined);
}
const LazyTaskDetailDialog = lazy(loadTaskDetailDialog);
export interface TaskDetailDialogHostHandle {
  openTask: (task: TeamTaskWithKanban) => void;
  close: () => void;
}

interface TaskDetailDialogHostProps {
  teamName: string;
  kanbanTaskStateByTaskId: Record<string, KanbanTaskState>;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onOwnerChange: (taskId: string, owner: string | null) => void;
  onViewChanges: (taskId: string, filePath?: string) => void;
  onOpenInEditor: (intent: TaskDetailFileLinkIntent) => void;
  onDeleteTask: (taskId: string) => void;
}

export const TaskDetailDialogHost = memo(
  forwardRef<TaskDetailDialogHostHandle, TaskDetailDialogHostProps>(function TaskDetailDialogHost(
    {
      teamName,
      kanbanTaskStateByTaskId,
      taskMap,
      members,
      onOwnerChange,
      onViewChanges,
      onOpenInEditor,
      onDeleteTask,
    },
    ref
  ) {
    const contextId = useStore((state) => state.activeContextId);
    const [selectedIdentity, setSelectedIdentity] = useState<TaskDetailIdentity | null>(null);
    const selectedKey = selectedIdentity ? taskDetailKey(selectedIdentity) : null;
    const detailEntry = useStore((state) =>
      selectedKey ? state.taskDetailById[selectedKey] : undefined
    );
    const setTaskDetailSurfaceInterest = useStore((state) => state.setTaskDetailSurfaceInterest);
    const projectPath = useStore(
      (state) => selectTeamDataForName(state, teamName)?.config.projectPath ?? null
    );
    const currentTask = detailEntry?.full ?? null;
    const surfaceIdRef = useRef(crypto.randomUUID());
    const sessionIdentity = useMemo(
      () => selectedIdentity ?? { contextId, teamName, taskId: '' },
      [contextId, selectedIdentity, teamName]
    );
    const sessionController = useTaskDetailSession({
      identity: sessionIdentity,
      surfaceId: surfaceIdRef.current,
      currentTask,
      enabled: Boolean(selectedIdentity),
    });

    useImperativeHandle(
      ref,
      () => ({
        openTask: (task) => {
          const identity = { contextId, teamName, taskId: task.id };
          setSelectedIdentity(identity);
        },
        close: () => {
          setSelectedIdentity(null);
        },
      }),
      [contextId, teamName]
    );

    useEffect(() => {
      if (!selectedIdentity) return;
      if (selectedIdentity.contextId !== contextId || selectedIdentity.teamName !== teamName) {
        setSelectedIdentity(null);
      }
    }, [contextId, selectedIdentity, teamName]);

    const registeredIdentity =
      selectedIdentity?.contextId === contextId && selectedIdentity.teamName === teamName
        ? selectedIdentity
        : null;
    useEffect(() => {
      const surfaceId = surfaceIdRef.current;
      setTaskDetailSurfaceInterest(surfaceId, registeredIdentity);
      return () => setTaskDetailSurfaceInterest(surfaceId, null);
    }, [registeredIdentity, setTaskDetailSurfaceInterest]);

    const dialogTaskMap = useMemo(() => {
      const next = new Map<string, TeamTaskWithKanban>(taskMap);
      if (currentTask) next.set(currentTask.id, currentTask);
      return next;
    }, [currentTask, taskMap]);

    const handleScrollToTask = useCallback((taskId: string) => {
      setSelectedIdentity(null);
      const el = document.querySelector(`[data-task-id="${taskId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.classList.remove('kanban-card-focus-pulse');
        void (el as HTMLElement).offsetWidth;
        el.classList.add('kanban-card-focus-pulse');
        el.addEventListener('animationend', () => el.classList.remove('kanban-card-focus-pulse'), {
          once: true,
        });
      }
    }, []);

    if (!registeredIdentity) {
      return null;
    }

    const DialogComponent = loadedTaskDetailDialogComponent ?? LazyTaskDetailDialog;
    const dialog = (
      <DialogComponent
        open
        loading={
          currentTask === null &&
          ['hydrating', 'provisioning'].includes(detailEntry?.phase ?? 'hydrating')
        }
        task={currentTask}
        teamName={teamName}
        kanbanTaskState={kanbanTaskStateByTaskId[registeredIdentity.taskId]}
        taskMap={dialogTaskMap}
        members={members}
        onClose={() => setSelectedIdentity(null)}
        onOpenInTaskTab={() => {
          if (sessionController.openInTaskTab()) setSelectedIdentity(null);
        }}
        projectPath={projectPath}
        sessionController={sessionController}
        onScrollToTask={handleScrollToTask}
        onOwnerChange={(...args) => {
          if (sessionController.canEditNow()) onOwnerChange(...args);
        }}
        onViewChanges={(...args) => {
          if (sessionController.isOriginCurrent()) onViewChanges(...args);
        }}
        onOpenInEditor={(...args) => {
          if (sessionController.isOriginCurrent()) onOpenInEditor(...args);
        }}
        onDeleteTask={(...args) => {
          if (sessionController.canEditNow()) onDeleteTask(...args);
        }}
      />
    );

    if (loadedTaskDetailDialogComponent) {
      return dialog;
    }

    return <Suspense fallback={null}>{dialog}</Suspense>;
  })
);
TaskDetailDialogHost.displayName = 'TaskDetailDialogHost';
