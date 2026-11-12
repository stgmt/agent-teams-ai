import { evidenceFor, memberChanges, sameRun } from '../domain/reportFacts';

import { LeadReportSourceFailure } from './ports';
import { readSourceWithin, SourceDeadline } from './sourceDeadline';

import type {
  LeadInspection,
  LeadReportFacts,
  LeadReportRun,
  MemberInspection,
  SourceError,
  SourceStamp,
} from '../../contracts';
import type { LeadReportDependencies } from './ports';

export async function collectInspection(
  deps: LeadReportDependencies,
  report: Pick<LeadReportRun, 'run' | 'scope'>,
  baseline?: { messageId: string; inspection: LeadInspection }
): Promise<LeadReportFacts> {
  // Age includes every source await; finishing a slow read cannot renew its earlier facts.
  const observedAt = deps.now();
  const deadline = new SourceDeadline(deps.maxSourceWaitMs);
  const readRoster = () =>
    readSourceWithin(deadline, 'roster', () => deps.sources.roster(report.run));
  const roster = await readRoster();
  const names = roster.members.map((member) => member.name);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !name?.trim() || name !== name.trim()) ||
    roster.members.filter((member) => member.role === 'lead').length !== 1
  )
    throw new Error('Canonical roster contains invalid member identities');
  const allMembers = roster.members
    .filter((member) => member.role === 'member')
    .map((member) => member.name);
  const selected = report.scope.kind === 'team' ? allMembers : [...report.scope.memberNames];
  if (
    new Set(selected).size !== selected.length ||
    selected.some((name) => !allMembers.includes(name))
  )
    throw new Error('Report scope is not part of the canonical roster');
  selected.sort((a, b) => a.localeCompare(b));
  const [lifecycleRead, taskRead, resultRead] = await Promise.allSettled([
    readSourceWithin(deadline, 'lifecycle', () => deps.sources.lifecycle(report.run)),
    readSourceWithin(deadline, 'tasks', () => deps.sources.tasks(report.run)),
    readSourceWithin(deadline, 'results', () => deps.sources.results(report.run)),
  ]);
  const sourceErrors: SourceError[] = [];
  let lifecycle = lifecycleRead.status === 'fulfilled' ? lifecycleRead.value : null;
  if (lifecycle && !sameRun(lifecycle.identity, report.run)) lifecycle = null;
  const failure = (source: SourceError['source'], reason: unknown): SourceError =>
    reason instanceof LeadReportSourceFailure && reason.diagnostic.source === source
      ? { ...reason.diagnostic }
      : { source, code: 'unavailable' };
  if (!lifecycle)
    sourceErrors.push(
      failure('lifecycle', lifecycleRead.status === 'rejected' ? lifecycleRead.reason : null)
    );
  if (taskRead.status === 'rejected') sourceErrors.push(failure('tasks', taskRead.reason));
  if (resultRead.status === 'rejected') sourceErrors.push(failure('results', resultRead.reason));
  else
    sourceErrors.push(
      ...(resultRead.value.errors ?? []).filter(
        (error) => !error.memberName || selected.includes(error.memberName)
      )
    );
  const lifecycleStamp: SourceStamp | null = lifecycle
    ? {
        source: 'team-lifecycle',
        revision: String(lifecycle.version),
        observedAt,
      }
    : null;
  const tasks = taskRead.status === 'fulfilled' ? taskRead.value.tasks : [];
  const results = resultRead.status === 'fulfilled' ? resultRead.value.evidence : [];
  const evidenceIds = new Set<string>(selected.map((name) => `process:${name}`));
  for (const ref of [...tasks.flatMap((task) => task.evidence), ...results]) {
    if (!ref.evidenceId || evidenceIds.has(ref.evidenceId))
      throw new Error('Source evidence identities are not unique');
    evidenceIds.add(ref.evidenceId);
  }
  const members: MemberInspection[] = selected.map((name) => {
    const process = lifecycle?.members[name];
    const known = process?.membership === 'configured';
    if (lifecycle && !known)
      sourceErrors.push({ source: 'lifecycle', code: 'member-unavailable', memberName: name });
    const memberResults = results.filter((ref) => ref.memberName === name);
    return {
      name,
      process: known
        ? {
            source: lifecycleStamp,
            phase: process.phase,
            generation: process.generation,
            operationId: process.operationId,
            everConnected: process.everConnected,
            error: process.error,
          }
        : {
            source: null,
            phase: 'unknown',
            generation: null,
            operationId: null,
            everConnected: null,
            error: null,
          },
      tasks: tasks
        .filter((task) => task.memberName === name)
        .map((task) => {
          if (task.evidence.some((ref) => ref.memberName !== name || ref.taskId !== task.taskId))
            throw new Error('Task source evidence has a different owner or task');
          return {
            taskId: task.taskId,
            subject: task.subject,
            status: task.status,
            source: task.source,
            evidence: task.evidence,
          };
        })
        .sort((a, b) => a.taskId.localeCompare(b.taskId)),
      reportedResults: memberResults.filter((ref) => ref.verification !== 'verified'),
      verifiedResults: memberResults.filter((ref) => ref.verification === 'verified'),
      blockers: [],
    };
  });
  const membersWithBlockers: MemberInspection[] = members.map((member) => ({
    ...member,
    blockers: sourceErrors
      .filter((error) => !error.memberName || error.memberName === member.name)
      .map((error, index) => ({
        evidenceId: `source-error:${member.name}:${error.source}:${error.taskId ?? 'team'}:${index}`,
        memberName: member.name,
        ...(error.taskId ? { taskId: error.taskId } : {}),
        source: {
          source: `source-error:${error.source}`,
          revision: error.code,
          observedAt,
        },
        locator: `source:${error.source}${error.taskId ? `/task:${error.taskId}` : ''}`,
        topic: 'blocker' as const,
        verification: 'observed' as const,
        description: `Source ${error.source} is unavailable (${error.code})${error.detail ? `: ${error.detail}` : ''}. This is a source limitation, not work progress.`,
        occurredAt: null,
      })),
  }));
  const rosterAfter = await readRoster();
  if (
    rosterAfter.source.revision !== roster.source.revision ||
    JSON.stringify(rosterAfter.members) !== JSON.stringify(roster.members)
  )
    throw new Error('Canonical roster changed during inspection; inspect again');
  for (const member of membersWithBlockers) {
    const processEvidence = evidenceFor(member)[0];
    Object.assign(member.process, { evidence: processEvidence });
  }
  return {
    run: report.run,
    observedAt,
    roster: roster.source,
    scope: report.scope,
    members: membersWithBlockers,
    changesSinceLastReport: memberChanges(baseline?.inspection.members, membersWithBlockers),
    comparedToMessageId: baseline?.messageId ?? null,
    sourceErrors,
  };
}
