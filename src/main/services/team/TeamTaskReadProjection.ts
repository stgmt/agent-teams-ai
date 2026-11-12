import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { deriveTaskDisplayId, normalizeTaskRefs } from '@shared/utils/taskIdentity';

import { normalizeExecutionTaskMetadata } from './execution/ExecutionTaskMetadata';

import type {
  SourceMessageSnapshot,
  TaskAttachmentMeta,
  TaskComment,
  TaskHistoryEvent,
  TaskReviewInterval,
  TaskWorkInterval,
  TeamTask,
} from '@shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readCreationCommand(value: unknown): TeamTask['creationCommand'] {
  if (!isRecord(value)) return undefined;
  if (
    ['namespace', 'scopeKey', 'operation', 'commandId', 'payloadHash'].every(
      (key) => typeof value[key] === 'string'
    )
  )
    return value as unknown as TeamTask['creationCommand'];
  if (typeof value.idempotencyKey === 'string') return { idempotencyKey: value.idempotencyKey };
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function isRegistryStatus(value: unknown): value is NonNullable<TeamTask['registryStatus']> {
  return (
    typeof value === 'string' &&
    [
      'planned',
      'todo',
      'ready',
      'in-progress',
      'blocked',
      'done',
      'deleted',
      'deferred',
      'unknown',
    ].includes(value)
  );
}

function isRegistrySource(value: unknown): value is NonNullable<TeamTask['registrySource']> {
  return (
    isRecord(value) &&
    (value.path === null || typeof value.path === 'string') &&
    ['startLine', 'startColumn', 'endLine', 'endColumn'].every(
      (key) =>
        value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]))
    )
  );
}

function isRegistryTask(value: unknown): value is NonNullable<TeamTask['registryTask']> {
  if (!isRecord(value)) return false;
  return (
    ['canonicalId', 'specSlug', 'localId', 'title'].every(
      (key) => typeof value[key] === 'string'
    ) &&
    ['description', 'creationToken', 'phase', 'owner', 'tracking', 'contentHash'].every(
      (key) => value[key] === null || typeof value[key] === 'string'
    ) &&
    isRegistryStatus(value.status) &&
    isRegistrySource(value.source) &&
    ['requirements', 'dependsOn', 'blocks', 'blockedBy'].every(
      (key) => readStringArray(value[key]) !== undefined
    ) &&
    (value.body === undefined || typeof value.body === 'string')
  );
}

function isRegistryEntity(value: unknown): value is NonNullable<TeamTask['registryEntity']> {
  return (
    isRecord(value) &&
    ['canonicalId', 'specSlug', 'localId', 'kind', 'title', 'body'].every(
      (key) => typeof value[key] === 'string'
    ) &&
    isRecord(value.attributes) &&
    (value.contentHash === null || typeof value.contentHash === 'string') &&
    (value.span === null || isRegistrySource(value.span))
  );
}
/**
 * Normalise escaped newline sequences (`\\n`) that some MCP/CLI sources
 * write as literal two-character strings instead of real line-breaks.
 * Also handles `\\t` for consistency.  Only operates on isolated escape
 * sequences — already-real newlines are left untouched.
 */
export function unescapeLiteralNewlines(text: string): string {
  // Replace literal two-char sequences \n and \t with real control chars.
  // The regex matches a single backslash followed by 'n' or 't'.
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function isValidMimeTypeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  // Keep it reasonably bounded and avoid control characters.
  if (v.length > 200) return false;
  if (v.includes('\0') || /[\r\n]/.test(v)) return false;
  // Minimal MIME shape: type/subtype
  const slash = v.indexOf('/');
  if (slash <= 0 || slash === v.length - 1) return false;
  return true;
}

/** Decode the persisted execution/UI projection, never a canonical registry task source. */
export function readTaskFileProjection(
  parsed: Record<string, unknown>,
  signature: { mtimeMs: number }
): TeamTask {
  const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
  const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined;
  let updatedAt: string | undefined;
  try {
    updatedAt = new Date(signature.mtimeMs).toISOString();
  } catch {
    /* leave undefined */
  }

  // `satisfies Record<keyof TeamTask, unknown>` ensures compile-time
  // safety: if a field is added to TeamTask but not mapped here,
  // TypeScript will error. This prevents silently dropping new fields.
  const historyEvents: TaskHistoryEvent[] | undefined = Array.isArray(parsed.historyEvents)
    ? (parsed.historyEvents as unknown[])
        .filter(
          (e): e is Record<string, unknown> =>
            Boolean(e) &&
            typeof e === 'object' &&
            typeof (e as Record<string, unknown>).id === 'string' &&
            typeof (e as Record<string, unknown>).timestamp === 'string' &&
            typeof (e as Record<string, unknown>).type === 'string'
        )
        .map((e) => e as unknown as TaskHistoryEvent)
    : undefined;
  const workIntervals: TaskWorkInterval[] | undefined = Array.isArray(parsed.workIntervals)
    ? (parsed.workIntervals as unknown[])
        .filter(
          (i): i is { startedAt: string; completedAt?: string } =>
            Boolean(i) &&
            typeof i === 'object' &&
            typeof (i as Record<string, unknown>).startedAt === 'string' &&
            ((i as Record<string, unknown>).completedAt === undefined ||
              typeof (i as Record<string, unknown>).completedAt === 'string')
        )
        .map((i) => ({
          startedAt: i.startedAt,
          completedAt: i.completedAt,
        }))
    : undefined;
  const reviewIntervals: TaskReviewInterval[] | undefined = Array.isArray(parsed.reviewIntervals)
    ? (parsed.reviewIntervals as unknown[])
        .filter(
          (i): i is { reviewer: string; startedAt: string; completedAt?: string } =>
            Boolean(i) &&
            typeof i === 'object' &&
            typeof (i as Record<string, unknown>).reviewer === 'string' &&
            typeof (i as Record<string, unknown>).startedAt === 'string' &&
            ((i as Record<string, unknown>).completedAt === undefined ||
              typeof (i as Record<string, unknown>).completedAt === 'string')
        )
        .map((i) => ({
          reviewer: i.reviewer,
          startedAt: i.startedAt,
          completedAt: i.completedAt,
        }))
    : undefined;
  const status = (['pending', 'in_progress', 'completed', 'deleted'] as const).includes(
    parsed.status as TeamTask['status']
  )
    ? (parsed.status as TeamTask['status'])
    : 'pending';
  const pendingKanbanTransition =
    parsed.pendingKanbanTransition === null || parsed.pendingKanbanTransition === undefined
      ? undefined
      : (normalizeExecutionTaskMetadata({
          pendingKanbanTransition: parsed.pendingKanbanTransition,
        }).pendingKanbanTransition ?? undefined);
  return {
    id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '',
    displayId:
      typeof parsed.displayId === 'string' && parsed.displayId.trim().length > 0
        ? parsed.displayId.trim()
        : deriveTaskDisplayId(
            typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : ''
          ),
    specProject: typeof parsed.specProject === 'string' ? parsed.specProject : undefined,
    specSlug: typeof parsed.specSlug === 'string' ? parsed.specSlug : undefined,
    registryLocalId:
      typeof parsed.registryLocalId === 'string' ? parsed.registryLocalId : undefined,
    registryStatus: isRegistryStatus(parsed.registryStatus) ? parsed.registryStatus : undefined,
    registryTask: isRegistryTask(parsed.registryTask) ? parsed.registryTask : undefined,
    registryEntity: isRegistryEntity(parsed.registryEntity) ? parsed.registryEntity : undefined,
    requirements: readStringArray(parsed.requirements),
    dependsOn: readStringArray(parsed.dependsOn),
    registryRefs: readStringArray(parsed.registryRefs),
    registryPhase:
      parsed.registryPhase === null || typeof parsed.registryPhase === 'string'
        ? parsed.registryPhase
        : undefined,
    tracking:
      parsed.tracking === null || typeof parsed.tracking === 'string' ? parsed.tracking : undefined,
    contentHash:
      parsed.contentHash === null || typeof parsed.contentHash === 'string'
        ? parsed.contentHash
        : undefined,
    registrySource: isRegistrySource(parsed.registrySource) ? parsed.registrySource : undefined,
    registryBody: typeof parsed.registryBody === 'string' ? parsed.registryBody : undefined,
    registryAttributes: isRecord(parsed.registryAttributes) ? parsed.registryAttributes : undefined,
    doneWhen:
      parsed.doneWhen === null || typeof parsed.doneWhen === 'string' ? parsed.doneWhen : undefined,
    creationCommand: readCreationCommand(parsed.creationCommand),
    subject,
    description:
      typeof parsed.description === 'string'
        ? unescapeLiteralNewlines(parsed.description)
        : undefined,
    descriptionTaskRefs: normalizeTaskRefs(parsed.descriptionTaskRefs),
    groupChatId: typeof parsed.groupChatId === 'string' ? parsed.groupChatId : undefined,
    activeForm: typeof parsed.activeForm === 'string' ? parsed.activeForm : undefined,
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
    promptTaskRefs: normalizeTaskRefs(parsed.promptTaskRefs),
    owner: typeof parsed.owner === 'string' ? parsed.owner : undefined,
    createdBy: typeof parsed.createdBy === 'string' ? parsed.createdBy : undefined,
    status,
    workIntervals,
    reviewIntervals,
    historyEvents,
    blocks: Array.isArray(parsed.blocks)
      ? (parsed.blocks as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined,
    blockedBy: Array.isArray(parsed.blockedBy)
      ? (parsed.blockedBy as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined,
    related: Array.isArray(parsed.related)
      ? (parsed.related as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined,
    createdAt,
    updatedAt,
    projectPath: typeof parsed.projectPath === 'string' ? parsed.projectPath : undefined,
    artifactRequirement: parsed.artifactRequirement as TeamTask['artifactRequirement'],
    comments: Array.isArray(parsed.comments)
      ? (parsed.comments as TaskComment[])
          .filter(
            (c) =>
              c &&
              typeof c === 'object' &&
              typeof c.id === 'string' &&
              typeof c.author === 'string' &&
              typeof c.text === 'string' &&
              typeof c.createdAt === 'string'
          )
          .map((c) => ({
            ...c,
            text: unescapeLiteralNewlines(c.text),
            type: (['regular', 'review_request', 'review_approved'] as const).includes(c.type)
              ? c.type
              : ('regular' as const),
            taskRefs: normalizeTaskRefs((c as unknown as Record<string, unknown>).taskRefs),
            attachments: Array.isArray(c.attachments)
              ? (() => {
                  const filtered = (c.attachments as unknown[])
                    .filter((a): a is TaskAttachmentMeta => {
                      if (!a || typeof a !== 'object') return false;
                      const row = a as Record<string, unknown>;
                      const size = row.size;
                      return (
                        typeof row.id === 'string' &&
                        typeof row.filename === 'string' &&
                        typeof row.mimeType === 'string' &&
                        isValidMimeTypeString(row.mimeType) &&
                        typeof size === 'number' &&
                        Number.isFinite(size) &&
                        size >= 0 &&
                        typeof row.addedAt === 'string'
                      );
                    })
                    .map((a) => ({
                      id: a.id,
                      filename: a.filename,
                      mimeType: String(a.mimeType).trim(),
                      size: a.size,
                      addedAt: a.addedAt,
                      ...('filePath' in a && typeof a.filePath === 'string'
                        ? { filePath: a.filePath }
                        : {}),
                    }));
                  return filtered.length > 0 ? filtered : undefined;
                })()
              : undefined,
          }))
      : undefined,
    needsClarification: (['lead', 'user'] as const).includes(
      parsed.needsClarification as 'lead' | 'user'
    )
      ? (parsed.needsClarification as 'lead' | 'user')
      : undefined,
    deletedAt: undefined, // deleted tasks are filtered out below
    attachments: Array.isArray(parsed.attachments)
      ? (parsed.attachments as unknown[])
          .filter((a): a is TaskAttachmentMeta => {
            if (!a || typeof a !== 'object') return false;
            const row = a as Record<string, unknown>;
            const size = row.size;
            return (
              typeof row.id === 'string' &&
              typeof row.filename === 'string' &&
              typeof row.mimeType === 'string' &&
              isValidMimeTypeString(row.mimeType) &&
              typeof size === 'number' &&
              Number.isFinite(size) &&
              size >= 0 &&
              typeof row.addedAt === 'string'
            );
          })
          .map((a) => ({
            id: a.id,
            filename: a.filename,
            mimeType: String(a.mimeType).trim(),
            size: a.size,
            addedAt: a.addedAt,
            ...(a.filePath != null && typeof a.filePath === 'string'
              ? { filePath: a.filePath }
              : {}),
          }))
      : undefined,
    reviewState: getReviewStateFromTask({
      historyEvents,
      reviewState: parsed.reviewState as TeamTask['reviewState'],
      status,
    }),
    pendingKanbanTransition,
    sourceMessageId:
      typeof parsed.sourceMessageId === 'string' && parsed.sourceMessageId.trim()
        ? parsed.sourceMessageId.trim()
        : undefined,
    sourceMessage:
      parsed.sourceMessage &&
      typeof parsed.sourceMessage === 'object' &&
      typeof (parsed.sourceMessage as Record<string, unknown>).text === 'string' &&
      typeof (parsed.sourceMessage as Record<string, unknown>).from === 'string' &&
      typeof (parsed.sourceMessage as Record<string, unknown>).timestamp === 'string'
        ? (parsed.sourceMessage as SourceMessageSnapshot)
        : undefined,
  } satisfies Record<keyof TeamTask, unknown>;
}
