import { randomUUID } from 'node:crypto';

import type { DetectedError } from '@main/services/error/ErrorMessageBuilder';

/** Report failures once per team for this app session without retrying delivery. */
export function createInternalStorageCommentWarning(
  publish: (warning: DetectedError) => Promise<unknown>,
  getLocale: () => string
): (teamName: string, error: unknown) => void {
  const reportedTeams = new Set<string>();
  const sessionId = randomUUID();
  return (teamName) => {
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
      dedupeKey: `comment-journal-unavailable:${sessionId}:${teamName}`,
      target: { kind: 'team', teamName, section: 'tasks' },
      context: { projectName: teamName },
    };
    try {
      void publish(warning).catch(() => undefined);
    } catch {
      // Preserve the original journal error; do not retry an uncertain report.
    }
  };
}
