import type {
  SourceMessageSnapshot,
  TaskRef,
  TeamReviewState,
  TaskCreationCommand,
} from '@shared/types';

/** Non-canonical context that must survive registry reads and process restarts. */
export interface ExecutionTaskMetadata {
  reviewState?: TeamReviewState;
  activeForm?: string;
  groupChatId?: string;
  prompt?: string;
  projectPath?: string;
  descriptionTaskRefs?: TaskRef[];
  promptTaskRefs?: TaskRef[];
  sourceMessageId?: string;
  sourceMessage?: SourceMessageSnapshot;
  createdBy?: string;
  creationCommand?: TaskCreationCommand;
}

export type ExecutionTaskMetadataPatch = {
  [K in keyof ExecutionTaskMetadata]?: ExecutionTaskMetadata[K] | null;
};

export const EXECUTION_TASK_METADATA_FIELDS = [
  'reviewState',
  'activeForm',
  'groupChatId',
  'prompt',
  'projectPath',
  'descriptionTaskRefs',
  'promptTaskRefs',
  'sourceMessageId',
  'sourceMessage',
  'createdBy',
  'creationCommand',
] as const satisfies readonly (keyof ExecutionTaskMetadata)[];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function refs(value: unknown, label: string): TaskRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => {
    const ref = object(entry, label);
    return {
      taskId: string(ref.taskId, label),
      teamName: string(ref.teamName, label),
      displayId: string(ref.displayId, label),
    };
  });
}

export function normalizeExecutionTaskMetadata(
  source: Record<string, unknown>
): ExecutionTaskMetadataPatch {
  const result: Record<string, unknown> = {};
  for (const field of EXECUTION_TASK_METADATA_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (value === null) {
      result[field] = null;
      continue;
    }
    if (field === 'descriptionTaskRefs' || field === 'promptTaskRefs') {
      result[field] = refs(value, field);
    } else if (field === 'reviewState') {
      if (!['none', 'review', 'needsFix', 'approved'].includes(string(value, field)))
        throw new Error('Invalid reviewState');
      result[field] = value;
    } else if (field === 'creationCommand') {
      const command = object(value, field);
      const normalized: Record<string, string> = {};
      for (const key of ['namespace', 'scopeKey', 'operation', 'commandId', 'payloadHash']) {
        normalized[key] = string(command[key], `${field}.${key}`);
        if (!normalized[key].trim()) throw new Error(`${field}.${key} must not be blank`);
      }
      result[field] = normalized;
    } else if (field === 'sourceMessage') {
      const message = object(value, field);
      string(message.text, 'sourceMessage.text');
      string(message.from, 'sourceMessage.from');
      if (!Number.isFinite(Date.parse(string(message.timestamp, 'sourceMessage.timestamp'))))
        throw new Error('Invalid sourceMessage.timestamp');
      if (message.source !== undefined) string(message.source, 'sourceMessage.source');
      if (
        message.fileReferenceIds !== undefined &&
        (!Array.isArray(message.fileReferenceIds) ||
          message.fileReferenceIds.some((id) => typeof id !== 'string'))
      )
        throw new Error('Invalid sourceMessage.fileReferenceIds');
      if (message.attachments !== undefined && !Array.isArray(message.attachments))
        throw new Error('Invalid sourceMessage.attachments');
      result[field] = structuredClone(message);
    } else {
      result[field] = string(value, field);
    }
  }
  return result as ExecutionTaskMetadataPatch;
}
