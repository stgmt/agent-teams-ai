// @vitest-environment node
import { createInternalStorageCommentWarning } from '@main/internalStorageCommentWarning';
import { describe, expect, it, vi } from 'vitest';

import type { DetectedError } from '@main/services/error/ErrorMessageBuilder';

describe('comment journal warning', () => {
  it('notifies the user once per team without forwarding or retrying a comment', async () => {
    const publish = vi.fn(async (_warning: DetectedError) => undefined);
    const report = createInternalStorageCommentWarning(publish, () => 'ru');
    report('fixture-team', new Error('worker unavailable'));
    report('fixture-team', new Error('worker unavailable again'));
    report('other-team', new Error('worker unavailable'));
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(2);
    const warning = publish.mock.calls[0][0];
    expect(warning.message).toContain('результат неизвестен');
    expect(warning.message).toContain('вручную');
    expect(warning.target).toEqual({ kind: 'team', teamName: 'fixture-team', section: 'tasks' });
    expect(warning.dedupeKey).toContain('comment-journal-unavailable:');
  });

  it('falls back to English if the locale is unavailable and does not retry a failed notification', async () => {
    const publish = vi.fn(async (_warning: DetectedError) => {
      throw new Error('notification write failed');
    });
    const report = createInternalStorageCommentWarning(publish, () => {
      throw new Error('locale unavailable');
    });
    report('fixture-team', new Error('worker unavailable'));
    await Promise.resolve();
    report('fixture-team', new Error('worker unavailable'));
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].message).toContain('outcome is unknown');
  });
});
