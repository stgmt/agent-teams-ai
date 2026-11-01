import type {
  EvidenceRef,
  LeadInspection,
  LeadReportDraft,
  LeadReportRunIdentity,
  MemberInspection,
} from '../../contracts';

export function sameRun(a: LeadReportRunIdentity, b: LeadReportRunIdentity): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration &&
    a.teamName === b.teamName &&
    a.runId === b.runId
  );
}

/** Keep evidence content revisions, but not read times or unrelated lifecycle versions. */
export function factKey(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) => {
    if (key === 'observedAt') return undefined;
    if (key === 'source' && entry && typeof entry === 'object') {
      const stamp = entry as { source?: string; revision?: string };
      return stamp.source === 'team-lifecycle' || stamp.source === 'lifecycle'
        ? { source: stamp.source }
        : { source: stamp.source, revision: stamp.revision };
    }
    return entry;
  });
}

export function memberChanges(
  before: readonly MemberInspection[] | undefined,
  after: readonly MemberInspection[]
): LeadInspection['changesSinceLastReport'] {
  const previous = new Map(before?.map((member) => [member.name, member]));
  return after.flatMap((member) => {
    const old = previous.get(member.name);
    const areas: ('process' | 'tasks' | 'results')[] = [];
    if (!old || factKey(old.process) !== factKey(member.process)) areas.push('process');
    if (!old || factKey(old.tasks) !== factKey(member.tasks)) areas.push('tasks');
    if (
      !old ||
      factKey([old.reportedResults, old.verifiedResults]) !==
        factKey([member.reportedResults, member.verifiedResults])
    )
      areas.push('results');
    return areas.length ? [{ memberName: member.name, areas }] : [];
  });
}

export function evidenceFor(member: MemberInspection): readonly EvidenceRef[] {
  return [
    {
      evidenceId: `process:${member.name}`,
      memberName: member.name,
      source: member.process.source ?? {
        source: 'lifecycle',
        revision: 'unavailable',
        observedAt: '',
      },
      locator: `lifecycle:${member.name}`,
      topic: 'process',
      verification: 'observed',
      description: `Current lifecycle phase: ${member.process.phase}. This is not evidence of work progress.`,
      occurredAt: null,
    },
    ...member.tasks.flatMap((task) => task.evidence),
    ...member.blockers,
    ...member.reportedResults,
    ...member.verifiedResults,
  ];
}

export function validateDraft(inspection: LeadInspection, draft: LeadReportDraft): void {
  const expected = inspection.members.map((member) => member.name);
  const actual = draft.members.map((member) => member.memberName);
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    actual.some((name) => !expected.includes(name))
  )
    throw new Error('Report member coverage differs from inspection');
  if (
    !draft.summary.trim() ||
    !draft.nextStep.trim() ||
    draft.summary.length > 4000 ||
    draft.nextStep.length > 4000
  )
    throw new Error('Report requires a bounded summary and next step');
  for (const row of draft.members) {
    const member = inspection.members.find((entry) => entry.name === row.memberName)!;
    const evidence = new Map(evidenceFor(member).map((ref) => [ref.evidenceId, ref]));
    if (!row.statements.length || row.statements.length > 20)
      throw new Error('Member coverage requires bounded statements');
    for (const statement of row.statements) {
      if (!statement.text.trim() || statement.text.length > 4000 || !statement.evidenceIds.length)
        throw new Error('Report statement requires text and evidence');
      const refs = statement.evidenceIds.map((id) => evidence.get(id));
      if (refs.some((ref) => !ref))
        throw new Error('Report evidence is missing or belongs to another member');
      if (
        statement.kind === 'result' &&
        !refs.some((ref) => ref?.topic === 'result' && ref.verification === 'verified')
      )
        throw new Error('A result requires independently verified result evidence');
      if (
        (statement.kind === 'blocker' || statement.kind === 'action') &&
        !refs.some((ref) => ref?.topic === statement.kind)
      )
        throw new Error(`${statement.kind} requires matching evidence`);
    }
    if (
      member.tasks.length &&
      !row.statements.some((statement) =>
        statement.evidenceIds.some((id) => evidence.get(id)?.topic !== 'process')
      )
    )
      throw new Error('Assigned work requires task evidence, not just process availability');
  }
}

function verificationLabel(
  refs: readonly EvidenceRef[]
): 'verified edit' | 'member claim' | 'source limitation' | 'board fact' {
  if (refs.some((ref) => ref.verification === 'verified' && ref.topic === 'result'))
    return 'verified edit';
  if (refs.some((ref) => ref.topic === 'blocker')) return 'source limitation';
  if (refs.some((ref) => ref.verification === 'reported')) return 'member claim';
  return 'board fact';
}

export function renderReport(inspection: LeadInspection, draft: LeadReportDraft): string {
  const verified = inspection.members.reduce(
    (total, member) => total + member.verifiedResults.length,
    0
  );
  const reported = inspection.members.reduce(
    (total, member) => total + member.reportedResults.length,
    0
  );
  const blockers = draft.members.reduce(
    (total, member) => total + member.statements.filter((statement) => statement.kind === 'blocker').length,
    0
  );
  const observed = new Date(inspection.observedAt);
  const observedLabel = Number.isNaN(observed.getTime())
    ? inspection.observedAt
    : `${observed.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const counts = [
    `${inspection.members.length} member(s) checked`,
    `${verified} independently captured edit(s)`,
    `${reported} member-reported claim(s)`,
  ];
  if (blockers) counts.push(`${blockers} blocker(s)`);
  if (inspection.sourceErrors.length)
    counts.push(`${inspection.sourceErrors.length} source limitation(s)`);
  const lines = [
    // The model's summary is an internal draft; the owner-facing headline is machine-built
    // from validated facts so free prose cannot smuggle an unsupported completion claim.
    `Team report: ${counts.join(', ')}.`,
    `Facts observed: ${observedLabel}. Tests, reviews and merges are not independently verified by this report.`,
    ...(inspection.scope.kind === 'members'
      ? [`Scope: only ${inspection.scope.memberNames.join(', ')}; not a whole-team report.`]
      : []),
    '',
    ...draft.members.map((member) => {
      const observedMember = inspection.members.find((entry) => entry.name === member.memberName)!;
      const evidence = new Map(evidenceFor(observedMember).map((ref) => [ref.evidenceId, ref]));
      const statements = member.statements.map((statement) => {
        const refs = statement.evidenceIds
          .map((id) => evidence.get(id))
          .filter((ref): ref is EvidenceRef => !!ref);
        return `[${verificationLabel(refs)}] ${statement.text.trim()}`;
      });
      return `${member.memberName}: ${statements.join(' ')}`;
    }),
  ];
  if (inspection.sourceErrors.length)
    lines.push(
      '',
      `Sources unavailable: ${inspection.sourceErrors
        .map((error) => {
          const subject = SOURCE_SUBJECTS[error.source] ?? error.source;
          const reason = SOURCE_REASONS[error.code] ?? 'could not be read';
          const owner = [error.memberName, error.taskId].filter(Boolean).join('/');
          const detail = error.detail ? ` — ${error.detail}` : '';
          return `${subject}${owner ? ` for ${owner}` : ''}: ${reason}${detail}`;
        })
        .join('; ')}.`
    );
  lines.push('', `Proposed next step: ${draft.nextStep.trim()}`);
  return lines.join('\n');
}

/** Product-facing limitation text; internal attempt counters never reach the owner. */
export function renderReportLimitation(reason: string | undefined): string {
  const cause =
    reason === 'inspection attempt limit'
      ? 'the team data sources did not answer in time or kept changing during verification'
      : reason === 'publication correction limit'
        ? 'the report could not be matched to verified facts after several attempts'
        : 'the report could not be completed';
  return [
    'I could not produce a verified team report for this request.',
    `Reason: ${cause}.`,
    'No member status, completed work or management action is confirmed by this failed attempt.',
    'Send a new request after the team data sources recover.',
  ].join('\n');
}

const SOURCE_SUBJECTS: Record<string, string> = {
  lifecycle: 'member process state',
  tasks: 'task board',
  results: 'task results',
};

const SOURCE_REASONS: Record<string, string> = {
  'source-timeout': 'did not answer in time',
  unavailable: 'could not be read',
  'member-unavailable': 'has no readable state',
  'task-ledger-read-failed': 'could not be read',
  'source-read-failed': 'could not be read',
};
