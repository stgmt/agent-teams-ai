import { describe, expect, it } from 'vitest';

import { buildNotRunningDialogModel } from '../notRunningDialogModel';

import type { DowntimeEpisode } from '../../../core/domain/downtimeEpisode';

const formatTime = (iso: string): string => `T(${iso})`;
const occurredAt = '2026-10-24T05:48:27.000Z';
const messageAt = '2026-10-24T05:50:00.000Z';

function exited(exitCode: number | null, cliLogsTail?: string): DowntimeEpisode {
  return { exit: { exitCode, occurredAt, cliLogsTail }, ownerMessageAt: null, dismissed: false };
}

const messageOnly: DowntimeEpisode = { exit: null, ownerMessageAt: messageAt, dismissed: false };

describe('buildNotRunningDialogModel', () => {
  it('NM-S15: a non-zero code selects exitedAt with the time and the code', () => {
    const model = buildNotRunningDialogModel(exited(1, 'tail'), 0, formatTime);

    expect(model.reason).toEqual({
      key: 'detail.notRunning.exitedAt',
      values: { time: `T(${occurredAt})`, code: 1 },
    });
    expect(model.details).toBe('tail');
  });

  it('NM-S16: code 0 and a missing code select their own texts', () => {
    expect(buildNotRunningDialogModel(exited(0), 0, formatTime).reason.key).toBe(
      'detail.notRunning.exitedNormally'
    );
    expect(buildNotRunningDialogModel(exited(null), 0, formatTime).reason.key).toBe(
      'detail.notRunning.exitedNoCode'
    );
  });

  it('NM-S17: a message to a team without a witnessed exit says it was saved, no details', () => {
    const model = buildNotRunningDialogModel(messageOnly, 3, formatTime);

    expect(model.reason).toEqual({ key: 'detail.notRunning.savedForLater', values: {} });
    expect(model.saved).toBeNull();
    expect(model.details).toBeNull();
    expect(model.queued).toBeNull();
  });

  it('NM-S17: a message after a witnessed exit keeps the exit reason and adds the saved line', () => {
    const model = buildNotRunningDialogModel(
      { ...exited(1, 'tail'), ownerMessageAt: messageAt },
      1,
      formatTime
    );

    expect(model.reason.key).toBe('detail.notRunning.exitedAt');
    expect(model.saved).toEqual({ key: 'detail.notRunning.savedForLater', values: {} });
    expect(model.queued).toBeNull();
    expect(model.details).toBe('tail');
  });

  it('NM-S18: the queue line appears after an exit only when messages are waiting', () => {
    expect(buildNotRunningDialogModel(exited(1), 2, formatTime).queued).toEqual({
      key: 'detail.notRunning.queued',
      values: { queued: 2 },
    });
    expect(buildNotRunningDialogModel(exited(1), 0, formatTime).queued).toBeNull();
    expect(buildNotRunningDialogModel(exited(1), 0, formatTime).saved).toBeNull();
  });

  it('drops an empty or blank log tail instead of showing an empty block', () => {
    expect(buildNotRunningDialogModel(exited(1, '  \n'), 0, formatTime).details).toBeNull();
    expect(buildNotRunningDialogModel(exited(1), 0, formatTime).details).toBeNull();
  });
});
