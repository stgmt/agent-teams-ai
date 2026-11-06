import { EMPTY_TASK_DETAIL_SESSION } from '@features/team-task-detail/core/domain';
import { vi } from 'vitest';

import type { TaskDetailSessionController } from '@features/team-task-detail/renderer';

export function createTaskDetailSessionFixture(taskId: string): TaskDetailSessionController {
  return {
    identity: { contextId: 'local', teamName: 'team-a', taskId },
    surfaceId: 'TEST-dialog',
    session: { ...EMPTY_TASK_DETAIL_SESSION, ownerSurfaceId: 'TEST-dialog', ownerRevision: 1 },
    isOwner: true,
    canEditNow: () => true,
    markArtifactOutcomeUnknown: vi.fn(),
    checkArtifactOutcome: vi.fn(async () => {}),
    confirmArtifactOutcome: vi.fn(async () => {}),
    updateTaskArtifact: vi.fn(async () => {}),
    taskWriteGuard: {
      status: 'ready',
      reason: null,
      activeId: null,
      markerId: null,
      operation: null,
      unknown: false,
      checked: false,
      expectedContext: null,
      expectedRootFingerprint: null,
    },
    beginGuardedTaskWrite: vi.fn(async () => ({
      token: 'test',
      expectedContext: {
        appInstanceId: 'test',
        dataRootFingerprint: 'a'.repeat(64),
        connectionGeneration: 1,
      },
      expectedRootFingerprint: 'a'.repeat(64),
    })),
    settleGuardedTaskWrite: vi.fn(async () => true),
    checkGuardedTaskWriteOutcome: vi.fn(async () => {}),
    confirmGuardedTaskWriteOutcome: vi.fn(async () => {}),
    isOriginCurrent: () => true,
    canSubmit: true,
    isDraftSaved: false,
    attachmentError: null,
    setCommentText: vi.fn(),
    setCommentChips: vi.fn(),
    addCommentChip: vi.fn(),
    removeCommentChip: vi.fn(),
    setReply: vi.fn(),
    addPendingFiles: vi.fn(async () => {}),
    removePendingAttachment: vi.fn(),
    clearAttachmentError: vi.fn(),
    submitComment: vi.fn(async () => {}),
    startEditSubject: vi.fn(),
    cancelEditSubject: vi.fn(),
    setSubjectDraft: vi.fn(),
    saveSubject: vi.fn(async () => {}),
    startEditDescription: vi.fn(),
    cancelEditDescription: vi.fn(),
    setDescriptionDraft: vi.fn(),
    saveDescription: vi.fn(async () => {}),
    openInTaskTab: vi.fn(() => false),
  };
}
