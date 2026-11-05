import type { NativeTeamProvisioningRoot } from '@features/team-provisioning';
import {
  computeLiveTeamWatchScope,
  computeTeamWatchScope,
  setAliveTeamsProvider,
  setTeamWatchScopeChangeListener,
} from '@main/services/infrastructure/teamWatchScope';
import { openCodeRelayDiagnosticsLogGate } from '@main/services/team/opencode/delivery/OpenCodeRelayDiagnosticsLogGate';
import { extractNotificationContent } from '@main/utils/inboxNotificationContent';
import { shouldSuppressDesktopNotificationForInboxText } from '@shared/utils/idleNotificationSemantics';
import { isReviewPickupEscalationMessage } from '@shared/utils/teamAutomationMessages';
import { isTeamInternalControlMessageEnvelope } from '@shared/utils/teamInternalControlMessages';
import { TEAM_CHANGE } from '@preload/constants/ipcChannels';
import { configManager } from './services';
import type {
  NotificationManager,
  TeamBackupService,
  TeamDataService,
  ServiceContext,
} from './services';
import { safeSendToRenderer } from './utils/safeWebContentsSend';
import { getTeamsBasePath } from './utils/pathDecoder';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { HttpServer } from './services/infrastructure/HttpServer';
import type { FileChangeEvent } from '@main/types';
import type { TeamChangeEvent } from '@shared/types';
import type { TeamInboxReader } from './services/team/TeamInboxReader';
import type { TeamSentMessagesStore } from './services/team/TeamSentMessagesStore';
import {
  createTeamReconcileDrainScheduler,
  type TeamReconcileTrigger,
} from './services/team/TeamReconcileDrainScheduler';

interface AppLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  diagnostic(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const TEAM_DISPLAY_NAME_TTL_MS = 30_000;
const INBOX_NOTIFY_DEBOUNCE_MS = 500;
const suppressedSources = new Set(['user_sent']);

export interface MainFileWatcherEventDependencies {
  logger: AppLogger;
  getMainWindow: () => BrowserWindow | null;
  getHttpServer: () => HttpServer | undefined;
  getTeamDataService: () => TeamDataService | undefined;
  getTeamProvisioningService: () => NativeTeamProvisioningRoot;
  getTeamBackupService: () => TeamBackupService | null;
  getNotificationManager: () => NotificationManager;
  teamInboxReader: TeamInboxReader;
  sentMessagesStore: TeamSentMessagesStore;
  notifyCoreTeamChangeObservers: (event: TeamChangeEvent) => void;
  warnTeamChangeForwardFailure: (target: string, error: unknown) => void;
}

export function createMainFileWatcherEventWiring(deps: MainFileWatcherEventDependencies) {
  const inboxMessageCounts = new Map<string, number>();
  const sentMessageCounts = new Map<string, number>();
  const inboxNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let fileChangeCleanup: (() => void) | null = null;
  let todoChangeCleanup: (() => void) | null = null;
  let teamChangeCleanup: (() => void) | null = null;
  const teamDisplayNameCache = new Map<string, { value: string; expiresAt: number }>();
  let teamListInFlight: Promise<Map<string, string>> | null = null;

  async function refreshTeamDisplayNameCache(): Promise<Map<string, string>> {
    if (teamListInFlight) {
      return teamListInFlight;
    }

    teamListInFlight = (async () => {
      const out = new Map<string, string>();
      try {
        const teamDataService = deps.getTeamDataService();
        if (!teamDataService) return out;
        const summary = await teamDataService.listTeams();
        for (const team of summary) {
          if (team?.teamName) {
            out.set(team.teamName, team.displayName || team.teamName);
          }
        }
      } catch {
        // ignore
      } finally {
        teamListInFlight = null;
      }
      return out;
    })();

    return teamListInFlight;
  }

  async function resolveTeamDisplayName(teamName: string): Promise<string> {
    const cached = teamDisplayNameCache.get(teamName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const map = await refreshTeamDisplayNameCache();
    const resolved = map.get(teamName) ?? teamName;
    teamDisplayNameCache.set(teamName, {
      value: resolved,
      expiresAt: Date.now() + TEAM_DISPLAY_NAME_TTL_MS,
    });
    return resolved;
  }

  async function notifyNewInboxMessages(teamName: string, detail: string): Promise<void> {
    deps.logger.debug(`[inbox-notify] called: team=${teamName} detail=${detail}`);
    const config = configManager.getConfig();

    // Skip orphaned team directories without config.json (e.g., "default").
    // Claude Code may write to these when its internal teamContext is lost after session resume.
    // Our stdout capture in TeamProvisioningService already persists these messages under the
    // correct team name via sentMessages.json, so inbox notifications from orphaned dirs
    // would be duplicates with a wrong team name.
    if (!existsSync(join(getTeamsBasePath(), teamName, 'config.json'))) {
      deps.logger.debug(`[inbox-notify] skipped: no config.json for team=${teamName}`);
      return; // No config.json → orphaned team dir, skip notification
    }

    // detail is like "inboxes/carol.json" — extract member name
    const match = /^inboxes\/(.+)\.json$/.exec(detail);
    if (!match) return;
    const memberName = match[1];

    // Determine inbox type and per-type toggle state.
    // Storage is always unconditional; toggles only suppress the OS toast.
    const teamDataService = deps.getTeamDataService();
    const leadName = teamDataService ? await teamDataService.getLeadMemberName(teamName) : null;
    const isLeadInbox = leadName !== null && memberName === leadName;
    const isUserInbox = memberName === 'user';

    if (!isLeadInbox && !isUserInbox) return;

    const suppressToast =
      !config.notifications.enabled ||
      (isLeadInbox && !config.notifications.notifyOnLeadInbox) ||
      (isUserInbox && !config.notifications.notifyOnUserInbox);

    const key = `${teamName}:${memberName}`;

    try {
      const messages = await deps.teamInboxReader.getMessagesFor(teamName, memberName);
      const isFirstLoad = !inboxMessageCounts.has(key);
      const prevCount = inboxMessageCounts.get(key) ?? 0;

      if (isFirstLoad) {
        // First load — seed count, don't notify for pre-existing messages
        deps.logger.debug(`[inbox-notify] first load for ${key}: seeding count=${messages.length}`);
        inboxMessageCounts.set(key, messages.length);
        return;
      }

      if (messages.length <= prevCount) {
        inboxMessageCounts.set(key, messages.length);
        return;
      }

      // Messages are sorted newest-first, so new ones are at the beginning
      const newMessages = messages.slice(0, messages.length - prevCount);
      inboxMessageCounts.set(key, messages.length);

      deps.logger.debug(
        `[inbox-notify] ${key}: prevCount=${prevCount} newCount=${messages.length} newMessages=${newMessages.length} suppressToast=${String(suppressToast)}`
      );

      const teamDisplayName = await resolveTeamDisplayName(teamName);

      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        // Comment forwards are lead runtime inputs; the task detector owns user notifications.
        if (msg.messageKind === 'task_comment_notification') continue;
        if (msg.source && suppressedSources.has(msg.source)) continue;
        // Skip app-owned private bootstrap/control prompts. They are durable runtime proof inputs,
        // not user-visible conversation messages.
        if (isTeamInternalControlMessageEnvelope(msg)) continue;
        // Skip internal review-pickup escalations to the lead runtime.
        if (isReviewPickupEscalationMessage(msg)) continue;
        // Skip internal coordination noise (idle_notification, shutdown_*, etc.)
        if (shouldSuppressDesktopNotificationForInboxText(msg.text)) continue;

        const fromLabel = msg.from || 'Unknown';
        const extracted = extractNotificationContent(msg.text);
        const summary = msg.summary || extracted.summary;
        const msgId = msg.timestamp ?? String(prevCount + i);

        // Cross-team messages get their own event type and per-type toggle
        const isCrossTeam = msg.source === 'cross_team';
        const eventType: 'lead_inbox' | 'user_inbox' | 'cross_team_message' = isCrossTeam
          ? 'cross_team_message'
          : isLeadInbox
            ? 'lead_inbox'
            : 'user_inbox';
        const effectiveSuppressToast = isCrossTeam
          ? !config.notifications.enabled || !config.notifications.notifyOnCrossTeamMessage
          : suppressToast;

        void deps
          .getNotificationManager()
          .addTeamNotification({
            teamEventType: eventType,
            teamName,
            teamDisplayName,
            from: fromLabel,
            summary,
            body: extracted.body,
            dedupeKey: `inbox:${teamName}:${memberName}:${msgId}`,
            target: isCrossTeam
              ? { kind: 'team', teamName, section: 'messages' }
              : { kind: 'member', teamName, memberName: fromLabel, focus: 'messages' },
            suppressToast: effectiveSuppressToast,
          })
          .catch(() => undefined);
      }
    } catch (error) {
      deps.logger.warn(`Failed to check inbox messages for ${key}:`, error);
    }
  }

  async function notifyNewSentMessages(teamName: string): Promise<void> {
    const config = configManager.getConfig();
    const suppressToast = !config.notifications.enabled || !config.notifications.notifyOnUserInbox;

    try {
      const messages = await deps.sentMessagesStore.readMessages(teamName);
      const isFirstLoad = !sentMessageCounts.has(teamName);
      const prevCount = sentMessageCounts.get(teamName) ?? 0;

      if (isFirstLoad) {
        sentMessageCounts.set(teamName, messages.length);
        return;
      }

      if (messages.length <= prevCount) {
        sentMessageCounts.set(teamName, messages.length);
        return;
      }

      // Messages are appended at the end, new ones are at the tail
      const newMessages = messages.slice(prevCount);
      sentMessageCounts.set(teamName, messages.length);

      const teamDisplayName = await resolveTeamDisplayName(teamName);

      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if ((msg.to ?? '').trim() !== 'user') continue;
        // Comment forwards are lead runtime inputs; the task detector owns user notifications.
        if (msg.messageKind === 'task_comment_notification') continue;
        if (msg.source && suppressedSources.has(msg.source)) continue;
        // Skip internal coordination noise
        if (shouldSuppressDesktopNotificationForInboxText(msg.text)) continue;

        const fromLabel = msg.from || 'team-lead';
        const extracted = extractNotificationContent(msg.text);
        const summary = msg.summary || extracted.summary;

        void deps
          .getNotificationManager()
          .addTeamNotification({
            teamEventType: 'user_inbox',
            teamName,
            teamDisplayName,
            from: fromLabel,
            summary,
            body: extracted.body,
            dedupeKey: `sent:${teamName}:${msg.timestamp ?? String(prevCount + i)}`,
            target: { kind: 'member', teamName, memberName: fromLabel, focus: 'messages' },
            suppressToast,
          })
          .catch(() => undefined);
      }
    } catch (error) {
      deps.logger.warn(`Failed to check sent messages for ${teamName}:`, error);
    }
  }

  function clearInboxNotifyTimers(): void {
    for (const timer of inboxNotifyTimers.values()) {
      clearTimeout(timer);
    }
    inboxNotifyTimers.clear();
  }

  function cleanup(): void {
    if (fileChangeCleanup) {
      fileChangeCleanup();
      fileChangeCleanup = null;
    }
    if (todoChangeCleanup) {
      todoChangeCleanup();
      todoChangeCleanup = null;
    }
    if (teamChangeCleanup) {
      teamChangeCleanup();
      teamChangeCleanup = null;
    }
  }

  function wire(context: ServiceContext): void {
    deps.logger.info(`Wiring FileWatcher events for context: ${context.id}`);

    // Clean up previous listeners
    cleanup();

    // Wire file-change events to renderer and HTTP SSE
    const SCAN_CACHE_INVALIDATE_DEBOUNCE_MS = 250;
    let scanCacheInvalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleScanCacheInvalidation = (): void => {
      if (scanCacheInvalidateTimer) {
        clearTimeout(scanCacheInvalidateTimer);
      }
      scanCacheInvalidateTimer = setTimeout(() => {
        scanCacheInvalidateTimer = null;
        context.projectScanner.clearScanCache();
      }, SCAN_CACHE_INVALIDATE_DEBOUNCE_MS);
    };

    const fileChangeHandler = (event: unknown): void => {
      // Avoid triggering a full project rescan on every session append.
      // The ProjectScanner already has a short TTL cache; we only invalidate for
      // structural changes (add/unlink), and we debounce bursts of events.
      try {
        if (event && typeof event === 'object') {
          const row = event as Partial<FileChangeEvent>;
          const isSubagent = row.isSubagent === true;
          const changeType = row.type;
          if (!isSubagent && (changeType === 'add' || changeType === 'unlink')) {
            scheduleScanCacheInvalidation();
          }
        } else {
          // Fallback: if we can't classify the event, invalidate (debounced).
          scheduleScanCacheInvalidation();
        }
      } catch {
        // ignore
      }

      safeSendToRenderer(deps.getMainWindow(), 'file-change', event);
      deps.getHttpServer()?.broadcast('file-change', event);
    };
    context.fileWatcher.on('file-change', fileChangeHandler);
    fileChangeCleanup = () => {
      context.fileWatcher.off('file-change', fileChangeHandler);
      if (scanCacheInvalidateTimer) {
        clearTimeout(scanCacheInvalidateTimer);
        scanCacheInvalidateTimer = null;
      }
    };

    // Forward checklist-change events to renderer and HTTP SSE (mirrors file-change pattern above)
    const todoChangeHandler = (event: unknown): void => {
      safeSendToRenderer(deps.getMainWindow(), 'todo-change', event);
      deps.getHttpServer()?.broadcast('todo-change', event);
    };
    context.fileWatcher.on('todo-change', todoChangeHandler);
    todoChangeCleanup = () => context.fileWatcher.off('todo-change', todoChangeHandler);

    const reconcileScheduler = deps.getTeamDataService()
      ? createTeamReconcileDrainScheduler({
          run: async (teamName: string, trigger: TeamReconcileTrigger) => {
            try {
              await deps.getTeamDataService()!.reconcileTeamArtifacts(teamName, trigger);
            } catch (e) {
              if (trigger.source === 'task') {
                deps.logger.warn(
                  `[FileWatcher] task reconcile failed for ${teamName} detail=${trigger.detail}: ${String(e)}`
                );
              } else {
                deps.logger.warn(
                  `[FileWatcher] reconcile failed for ${teamName} source=${trigger.source} detail=${trigger.detail}: ${String(e)}`
                );
              }
              throw e;
            }
          },
        })
      : null;

    // Forward team-change events to renderer and HTTP SSE
    const teamChangeHandler = (event: unknown): void => {
      try {
        safeSendToRenderer(deps.getMainWindow(), TEAM_CHANGE, event);
      } catch (error) {
        deps.warnTeamChangeForwardFailure('renderer send', error);
      }
      try {
        deps.getHttpServer()?.broadcast('team-change', event);
      } catch (error) {
        deps.warnTeamChangeForwardFailure('http broadcast', error);
      }

      // Process inbox and task change events.
      try {
        if (!event || typeof event !== 'object') return;
        const row = event as { type?: unknown; teamName?: unknown; detail?: unknown };
        if (typeof row.teamName !== 'string' || row.teamName.trim().length === 0) return;
        const teamName = row.teamName.trim();
        const detail = typeof row.detail === 'string' ? row.detail : '';
        deps.notifyCoreTeamChangeObservers(row as TeamChangeEvent);

        // --- Inbox change events: relay to lead + native OS notifications ---
        if (row.type === 'inbox') {
          reconcileScheduler?.schedule(teamName, { source: 'inbox', detail });

          // Relay inbox changes into active runtime recipients.
          if (detail.startsWith('inboxes/')) {
            const match = /^inboxes\/(.+)\.json$/.exec(detail);
            if (match) {
              const inboxName = match[1];

              void deps
                .getTeamProvisioningService()
                .relayInboxFileToLiveRecipient(teamName, inboxName)
                .then((relay) => {
                  openCodeRelayDiagnosticsLogGate.log(deps.logger, {
                    dedupKey: `${teamName}/${inboxName}`,
                    prefix: `[FileWatcher] relay diagnostics for ${teamName}/${inboxName}`,
                    diagnostics: relay.diagnostics,
                    nowMs: Date.now(),
                  });
                })
                .catch((e: unknown) =>
                  deps.logger.warn(`[FileWatcher] relay failed for ${teamName}: ${String(e)}`)
                );
            }
          }

          // Show native OS notification for new inbox messages (debounced per inbox).
          if (detail.startsWith('inboxes/')) {
            const timerKey = `${teamName}:${detail}`;
            const existing = inboxNotifyTimers.get(timerKey);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
              inboxNotifyTimers.delete(timerKey);
              void notifyNewInboxMessages(teamName, detail).catch(() => undefined);
            }, INBOX_NOTIFY_DEBOUNCE_MS);
            timer.unref?.();
            inboxNotifyTimers.set(timerKey, timer);
          }

          // Show native OS notification for new lead → user messages (sentMessages.json).
          if (detail === 'sentMessages.json') {
            const timerKey = `${teamName}:sentMessages`;
            const existing = inboxNotifyTimers.get(timerKey);
            if (existing) clearTimeout(existing);
            const timer = setTimeout(() => {
              inboxNotifyTimers.delete(timerKey);
              void notifyNewSentMessages(teamName).catch(() => undefined);
            }, INBOX_NOTIFY_DEBOUNCE_MS);
            timer.unref?.();
            inboxNotifyTimers.set(timerKey, timer);
          }
        }

        // --- Task change events: notify lead when teammate starts a task via CLI ---
        const teamDataService = deps.getTeamDataService();
        const teamBackupService = deps.getTeamBackupService();
        if (row.type === 'task' && detail.endsWith('.json') && teamDataService) {
          reconcileScheduler?.schedule(teamName, { source: 'task', detail });

          const taskId = detail.replace('.json', '');
          void teamDataService
            .notifyLeadOnTeammateTaskStart(teamName, taskId)
            .catch((e: unknown) =>
              deps.logger.warn(
                `[FileWatcher] task start notify failed for ${teamName}#${taskId}: ${String(e)}`
              )
            );
          void teamDataService
            .notifyLeadOnTeammateTaskComment(teamName, taskId)
            .catch((e: unknown) =>
              deps.logger.warn(
                `[FileWatcher] task comment notify failed for ${teamName}#${taskId}: ${String(e)}`
              )
            );

          // Schedule debounced backup for changed task file
          if (teamBackupService) {
            teamBackupService.scheduleTaskBackup(teamName, detail);
          }
        }

        // Backup on config changes (covers team ready, config updates)
        if (row.type === 'config' && detail === 'config.json' && teamBackupService) {
          void teamBackupService.backupTeam(teamName).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    };
    context.fileWatcher.on('team-change', teamChangeHandler);

    // Scope artifacts and inboxes to alive + recently engaged teams. Provisioning
    // can assign work before final readiness, so its engaged window must include
    // inbox delivery too. The bounded TTL excludes historical idle teams;
    // reconciliation backfills assignments written before watcher readiness.
    setAliveTeamsProvider(() => deps.getTeamProvisioningService().getAliveTeamNames());
    setTeamWatchScopeChangeListener(() => {
      void context.fileWatcher.refreshTeamWatchScope();
    });
    context.fileWatcher.setTeamWatchScopeProvider(() => computeTeamWatchScope());
    context.fileWatcher.setTeamInboxWatchScopeProvider(() => computeLiveTeamWatchScope());
    void context.fileWatcher.refreshTeamWatchScope();

    teamChangeCleanup = () => {
      context.fileWatcher.off('team-change', teamChangeHandler);
      setAliveTeamsProvider(null);
      setTeamWatchScopeChangeListener(null);
      context.fileWatcher.setTeamWatchScopeProvider(null);
      context.fileWatcher.setTeamInboxWatchScopeProvider(null);
      reconcileScheduler?.dispose();
    };

    deps.logger.info(`FileWatcher events wired for context: ${context.id}`);
  }

  return { wire, cleanup, clearInboxNotifyTimers };
}
