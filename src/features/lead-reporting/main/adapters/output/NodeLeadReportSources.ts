import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute } from 'node:path';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';
import { isCanonicalSettingsLeadMember } from '@shared/utils/leadDetection';
import agentTeamsController from 'agent-teams-controller';

import { LeadReportSourceFailure } from '../../../core/application/ports';

import type {
  EvidenceRef,
  LeadReportRunIdentity,
  SourceError,
  SourceStamp,
} from '../../../contracts';
import type {
  LeadReportSources,
  ResultsRead,
  RosterRead,
  TasksRead,
} from '../../../core/application/ports';
import type { TeamLifecycleSnapshot } from '@features/team-provisioning/contracts';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TaskChangeSetV2, TeamTask } from '@shared/types';

interface AgendaItem {
  taskId: string;
  subject: string;
  status: string;
  owner?: string;
  reviewer: string | null;
  nextAction: string;
  reasonCode: string;
  queueCategory: string;
  _fullTask: TeamTask;
}

interface Dependencies {
  teamsRoot: string;
  members: Pick<TeamMembersMetaStore, 'getMeta'>;
  lifecycle(run: LeadReportRunIdentity): Promise<Readonly<TeamLifecycleSnapshot> | null>;
  /**
   * Canonical team tasks already read by the app that owns the registry token. The
   * controller projects this detached snapshot; it never asks the app over its own
   * control API, which would park the thread serving that request.
   */
  tasks(run: LeadReportRunIdentity): Promise<readonly TeamTask[]>;
  taskChanges(input: {
    run: LeadReportRunIdentity;
    task: TeamTask;
  }): Promise<TaskChangeSetV2 | null>;
  now(): string;
}

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const MAX_COMMENTS_PER_TASK = 20;
const MAX_HISTORY_EVENTS_PER_TASK = 50;
const MAX_RESULTS_PER_MEMBER = 100;
const MAX_DESCRIPTION_CHARS = 600;

/** Teammate-authored text is data, never instructions: strip controls, bound and label it. */
function untrustedText(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
          .replace(/\p{Cc}+/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
      : '';
  return text.length > MAX_DESCRIPTION_CHARS
    ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : text;
}

/** Reads only the selected canonical profile. No work-sync writes, nudges or runtime probes. */
export class NodeLeadReportSources implements LeadReportSources {
  constructor(private readonly deps: Dependencies) {
    if (!isAbsolute(deps.teamsRoot) || basename(deps.teamsRoot) !== 'teams')
      throw new Error('An absolute canonical teams directory is required');
  }

  async roster(run: LeadReportRunIdentity): Promise<RosterRead> {
    this.validate(run);
    const meta = await this.deps.members.getMeta(run.teamName, {
      requireCompleteMembers: true,
      teamsBasePath: this.deps.teamsRoot,
    });
    if (!meta) throw new Error('Canonical saved roster is unavailable');
    const active = meta.members.filter((member) => !member.removedAt);
    const members = active.map((member) => ({
      name: member.name,
      role: isCanonicalSettingsLeadMember(member) ? ('lead' as const) : ('member' as const),
    }));
    if (!members.some((member) => member.role === 'lead'))
      members.unshift({ name: 'team-lead', role: 'lead' });
    members.sort((a, b) => a.name.localeCompare(b.name));
    return { source: this.stamp('canonical-members', members), members };
  }

  async lifecycle(run: LeadReportRunIdentity): Promise<Readonly<TeamLifecycleSnapshot> | null> {
    this.validate(run);
    let snapshot: Readonly<TeamLifecycleSnapshot> | null;
    try {
      snapshot = await this.deps.lifecycle(run);
    } catch (error) {
      throw this.sourceFailure('lifecycle', error);
    }
    if (!snapshot) return null;
    return {
      ...snapshot,
      error: boundedDiagnosticString(snapshot.error ?? undefined) ?? null,
      members: Object.fromEntries(
        Object.entries(snapshot.members).map(([name, member]) => [
          name,
          { ...member, error: boundedDiagnosticString(member.error ?? undefined) ?? null },
        ])
      ),
    };
  }

  async tasks(run: LeadReportRunIdentity): Promise<TasksRead> {
    const items = await this.board(run, 'tasks');
    const source = this.stamp('task-board', items);
    const tasks: TasksRead['tasks'][number][] = [];
    for (const item of items) {
      const taskSource = this.stamp('task-board-row', item);
      const names = new Set([item.owner, item.reviewer].filter((name): name is string => !!name));
      for (const memberName of names) {
        const evidence: EvidenceRef[] = [
          {
            evidenceId: `task:${item.taskId}:${memberName}`,
            memberName,
            taskId: item.taskId,
            source: taskSource,
            locator: `task:${item.taskId}`,
            topic: 'work',
            verification: 'observed',
            description: `${untrustedText(item.subject)}; recorded status=${untrustedText(item.status)}; next=${untrustedText(item.nextAction)}; reason=${untrustedText(item.reasonCode)}. A recorded status is not independent proof of completion.`,
            occurredAt: item._fullTask.updatedAt ?? item._fullTask.createdAt ?? null,
          },
        ];
        if (item.queueCategory === 'waiting' || item._fullTask.needsClarification)
          evidence.push({
            evidenceId: `blocker:${item.taskId}:${memberName}`,
            memberName,
            taskId: item.taskId,
            source: taskSource,
            locator: `task:${item.taskId}`,
            topic: 'blocker',
            verification: 'observed',
            description: `Board records ${item.reasonCode}; dependencies=${(item._fullTask.blockedBy ?? []).join(',') || 'none'}`,
            occurredAt: item._fullTask.updatedAt ?? null,
          });
        for (const event of (item._fullTask.historyEvents ?? []).slice(
          -MAX_HISTORY_EVENTS_PER_TASK
        )) {
          if (event.actor !== memberName) continue;
          evidence.push({
            evidenceId: `action:${item.taskId}:${event.id}:${memberName}`,
            memberName,
            taskId: item.taskId,
            source: taskSource,
            locator: `task:${item.taskId}/history:${event.id}`,
            topic: 'action',
            verification: 'observed',
            description: `Recorded board action: ${untrustedText(event.type)}`,
            occurredAt: event.timestamp,
          });
        }
        tasks.push({
          memberName,
          taskId: item.taskId,
          subject: item.subject,
          status: item.status,
          source: taskSource,
          evidence,
        });
      }
    }
    return { source, tasks };
  }

  async results(run: LeadReportRunIdentity): Promise<ResultsRead> {
    const items = await this.board(run, 'results');
    const evidence: EvidenceRef[] = [];
    const errors: SourceError[] = [];
    const source = this.stamp('task-results', items);
    for (const item of items) {
      const memberName = item.owner;
      if (!memberName) continue;
      for (const comment of (item._fullTask.comments ?? []).slice(-MAX_COMMENTS_PER_TASK)) {
        if (comment.author !== memberName) continue;
        evidence.push({
          evidenceId: `reported:${item.taskId}:${comment.id}`,
          memberName,
          taskId: item.taskId,
          source: this.stamp('task-result-comment', comment),
          locator: `task:${item.taskId}/comment:${comment.id}`,
          topic: 'result',
          verification: 'reported',
          description: `Member-reported text (untrusted): ${untrustedText(comment.text)}`,
          occurredAt: comment.createdAt,
        });
      }
      let changes: TaskChangeSetV2 | null;
      try {
        changes = await this.deps.taskChanges({ run, task: item._fullTask });
      } catch (error) {
        errors.push({
          source: 'results',
          code: 'task-ledger-read-failed',
          memberName,
          taskId: item.taskId,
          detail:
            boundedDiagnosticString(error instanceof Error ? error.message : undefined) ??
            'Task ledger read failed',
        });
        continue;
      }
      if (changes?.taskId !== item.taskId || changes.teamName !== run.teamName) continue;
      // The ledger verifies captured edits, not tests, merged commits or task completion.
      for (const file of changes.files) {
        if (
          file.ledgerSummary?.memberNames?.length !== 1 ||
          file.ledgerSummary.memberNames[0] !== memberName ||
          file.snippets.length === 0 ||
          changes.reviewDiagnostics?.some((diagnostic) => diagnostic.reviewBlocking)
        )
          continue;
        const exact = file.snippets.filter(
          (snippet) =>
            snippet.ledger?.source === 'ledger-exact' &&
            snippet.ledger.confidence === 'exact' &&
            snippet.ledger.textAvailability === 'full-text' &&
            snippet.ledger.originalFullContent !== snippet.ledger.modifiedFullContent &&
            !snippet.isError
        );
        if (!exact.length) continue;
        const ledgerSource = this.stamp(
          'task-change-ledger',
          exact.map((snippet) => snippet.ledger)
        );
        evidence.push({
          evidenceId: `verified-edit:${item.taskId}:${revision(file.filePath)}`,
          memberName,
          taskId: item.taskId,
          source: ledgerSource,
          locator: `task:${item.taskId}/file:${file.filePath}`,
          topic: 'result',
          verification: 'verified',
          description: `Task ledger contains ${exact.length} exact captured edit(s) in ${file.filePath}. This does not prove tests passed, a merge or task completion.`,
          occurredAt: exact.at(-1)?.timestamp ?? null,
        });
      }
    }
    return { source, evidence: this.capEvidence(evidence), errors };
  }

  private capEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
    const perMember = new Map<string, number>();
    return evidence.filter((ref) => {
      const count = perMember.get(ref.memberName) ?? 0;
      if (count >= MAX_RESULTS_PER_MEMBER) return false;
      perMember.set(ref.memberName, count + 1);
      return true;
    });
  }

  private stamp(source: string, value: unknown): SourceStamp {
    return { source, revision: revision(value), observedAt: this.deps.now() };
  }

  private validate(run: LeadReportRunIdentity): void {
    const valid = validateTeamName(run.teamName);
    if (!valid.valid || valid.value !== run.teamName) throw new Error('Invalid team identity');
  }

  private sourceFailure(source: SourceError['source'], error: unknown): LeadReportSourceFailure {
    return new LeadReportSourceFailure({
      source,
      code: 'source-read-failed',
      detail:
        boundedDiagnosticString(error instanceof Error ? error.message : undefined) ??
        'Source read failed without a diagnostic',
    });
  }

  /**
   * Projects canonical tasks into lead-report facts. The app owns the registry read, so
   * the controller receives the detached snapshot: resolving the app-bound task API
   * here would block this thread until the app's own control server could answer.
   */
  private async board(
    run: LeadReportRunIdentity,
    source: 'tasks' | 'results'
  ): Promise<AgendaItem[]> {
    this.validate(run);
    let tasks: readonly TeamTask[];
    try {
      tasks = await this.deps.tasks(run);
    } catch (error) {
      throw this.sourceFailure(source, error);
    }
    try {
      const controller = agentTeamsController.createController({
        teamName: run.teamName,
        claudeDir: dirname(this.deps.teamsRoot),
        allowUserMessageSender: true,
        readOnlyTaskSnapshot: [...tasks],
      });
      return controller.taskBoard.readLeadReportFacts() as AgendaItem[];
    } catch (error) {
      throw this.sourceFailure(source, error);
    }
  }
}
