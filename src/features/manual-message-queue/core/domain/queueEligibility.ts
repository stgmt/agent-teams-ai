export interface QueueEligibilityInput {
  actionMode: 'do' | 'ask' | 'delegate';
  isCrossTeam: boolean;
  attachmentCount: number;
  chipCount: number;
  editorKind: 'plain' | 'revision';
  restoredDeliveryUnknown: boolean;
  isSlashCommand: boolean;
}

export type QueueIneligibility =
  | 'delegate'
  | 'crossTeam'
  | 'attachments'
  | 'files'
  | 'revision'
  | 'unknownDelivery'
  | 'command';

export function queueIneligibility(input: QueueEligibilityInput): QueueIneligibility | null {
  if (input.isCrossTeam) return 'crossTeam';
  if (input.actionMode === 'delegate') return 'delegate';
  if (input.attachmentCount) return 'attachments';
  if (input.chipCount) return 'files';
  if (input.editorKind !== 'plain') return 'revision';
  if (input.restoredDeliveryUnknown) return 'unknownDelivery';
  return input.isSlashCommand ? 'command' : null;
}
