import { describe, expect, it } from 'vitest';

import { queueIneligibility } from '../../../src/features/manual-message-queue/core/domain/queueEligibility';

const plain = {
  actionMode: 'do' as const,
  isCrossTeam: false,
  attachmentCount: 0,
  chipCount: 0,
  editorKind: 'plain' as const,
  restoredDeliveryUnknown: false,
  isSlashCommand: false,
};

describe('queue eligibility explains the action, not imaginary content', () => {
  it('identifies Delegate independently of ordinary text', () => {
    expect(queueIneligibility({ ...plain, actionMode: 'delegate' })).toBe('delegate');
    expect(queueIneligibility(plain)).toBeNull();
    expect(queueIneligibility({ ...plain, actionMode: 'ask' })).toBeNull();
  });

  it.each([
    [{ isCrossTeam: true }, 'crossTeam'],
    [{ attachmentCount: 1 }, 'attachments'],
    [{ chipCount: 1 }, 'files'],
    [{ editorKind: 'revision' }, 'revision'],
    [{ restoredDeliveryUnknown: true }, 'unknownDelivery'],
    [{ isSlashCommand: true }, 'command'],
  ] as const)('retains a specific reason for %j', (change, reason) => {
    expect(queueIneligibility({ ...plain, ...change })).toBe(reason);
  });
});
