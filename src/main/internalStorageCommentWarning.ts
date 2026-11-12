import { randomUUID } from 'node:crypto';

import type { DetectedError } from '@main/services/error/ErrorMessageBuilder';

/** Report one warning per team outage without retrying comment delivery. */
export function createInternalStorageCommentWarning(
  publish: (warning: DetectedError) => Promise<unknown>,
  getLocale: () => string
): {
  onFailure: (teamName: string, error: unknown) => void;
  onMutationSuccess: (teamName: string) => void;
  onStorageUnavailable: (kind: 'recovery-required' | 'verification-required') => void;
} {
  const reportedTeams = new Set<string>();
  let storageUnavailableReported = false;
  /**
   * Calls the publisher synchronously and swallows both a synchronous throw and an
   * async rejection: an uncertain report is never retried or rethrown.
   */
  const publishQuietly = (warning: DetectedError): void => {
    void (async (): Promise<void> => {
      try {
        await publish(warning);
      } catch {
        // An uncertain report is never retried.
      }
    })();
  };
  const onFailure = (teamName: string): void => {
    if (storageUnavailableReported) return;
    if (reportedTeams.has(teamName)) return;
    reportedTeams.add(teamName);
    let russian = false;
    try {
      russian = getLocale() === 'ru';
    } catch {
      // An unavailable locale must not suppress the warning.
    }
    const message = russian
      ? 'Автоматическая пересылка комментариев руководителю недоступна или её результат неизвестен. Проверьте вручную последние комментарии, сообщения руководителя и состояние внутреннего хранилища.'
      : 'Automatic forwarding of task comments to the team lead is unavailable or its outcome is unknown. Check recent task comments, the lead inbox and internal storage manually.';
    const warning: DetectedError = {
      id: randomUUID(),
      timestamp: Date.now(),
      sessionId: `team:${teamName}`,
      projectId: teamName,
      filePath: '',
      source: 'internal-storage',
      message,
      category: 'error',
      triggerColor: 'orange',
      triggerName: russian ? 'Пересылка комментариев' : 'Comment forwarding',
      dedupeKey: `comment-journal-unavailable:${randomUUID()}:${teamName}`,
      requiresAcknowledgement: true,
      target: { kind: 'team', teamName, section: 'tasks' },
      context: { projectName: teamName },
    };
    // Preserve the original journal error; do not retry an uncertain report.
    publishQuietly(warning);
  };
  const onStorageUnavailable = (): void => {
    if (storageUnavailableReported) return;
    storageUnavailableReported = true;
    let russian = false;
    try {
      russian = getLocale() === 'ru';
    } catch {
      // An unavailable locale must not suppress the warning.
    }
    const warning: DetectedError = {
      id: randomUUID(),
      timestamp: Date.now(),
      sessionId: 'internal-storage',
      projectId: 'internal-storage',
      filePath: '',
      source: 'internal-storage',
      message: russian
        ? 'Внутреннее хранилище недоступно или требует восстановления. Шаблоны, отслеживание зависших задач, синхронизация работы участников и пересылка комментариев руководителю могут не работать. Проверьте состояние хранилища и последние действия вручную.'
        : 'Internal storage is unavailable or requires recovery. Templates, stalled-task monitoring, member work sync and forwarding comments to the team lead may not work. Check storage and recent actions manually.',
      category: 'error',
      triggerColor: 'orange',
      triggerName: russian ? 'Внутреннее хранилище' : 'Internal storage',
      dedupeKey: `internal-storage-unavailable:${randomUUID()}`,
      requiresAcknowledgement: true,
      context: { projectName: russian ? 'Внутреннее хранилище' : 'Internal storage' },
    };
    // Do not retry an uncertain report or alter the storage decision.
    publishQuietly(warning);
  };
  return {
    onFailure,
    onMutationSuccess: (teamName) => reportedTeams.delete(teamName),
    onStorageUnavailable,
  };
}
