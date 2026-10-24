import { describe, expect, it } from 'vitest';

import {
  dismissDowntimeEpisode,
  type DowntimePresentationContext,
  type ProcessExit,
  recordOwnerMessage,
  recordProcessExit,
  shouldPresentDowntimeEpisode,
} from '../downtimeEpisode';

const exit: ProcessExit = {
  exitCode: 1,
  occurredAt: '2026-10-24T05:48:27.000Z',
  cliLogsTail: 'boom',
};
const firstMessageAt = '2026-10-24T05:50:00.000Z';
const secondMessageAt = '2026-10-24T05:51:00.000Z';

const visibleDeadTeam: DowntimePresentationContext = {
  isTabActive: true,
  isAlive: false,
  isProvisioning: false,
  isLaunchDialogOpen: false,
};

describe('downtime episode', () => {
  describe('recordProcessExit', () => {
    it('NM-S06: opens a fresh, not yet dismissed episode with the exit and no owner message', () => {
      expect(recordProcessExit(undefined, exit)).toEqual({
        exit,
        ownerMessageAt: null,
        dismissed: false,
      });
    });

    it('keeps the first exit: a later one describes the same outage', () => {
      const first = recordProcessExit(undefined, exit);

      const again = recordProcessExit(first, { ...exit, exitCode: 137 });

      expect(again).toBe(first);
    });

    it('adds the exit to an episode the owner message opened and shows it again', () => {
      const dismissed = dismissDowntimeEpisode(recordOwnerMessage(undefined, firstMessageAt));

      expect(recordProcessExit(dismissed, exit)).toEqual({
        exit,
        ownerMessageAt: firstMessageAt,
        dismissed: false,
      });
    });
  });

  describe('recordOwnerMessage', () => {
    it('NM-S13: opens an episode that has no exit, only the message time', () => {
      expect(recordOwnerMessage(undefined, firstMessageAt)).toEqual({
        exit: null,
        ownerMessageAt: firstMessageAt,
        dismissed: false,
      });
    });

    it('NM-S07: a message after a dismissed notice shows the notice again', () => {
      const dismissed = dismissDowntimeEpisode(recordProcessExit(undefined, exit));

      const again = recordOwnerMessage(dismissed, secondMessageAt);

      expect(again).toEqual({ exit, ownerMessageAt: secondMessageAt, dismissed: false });
      expect(again).not.toBe(dismissed);
    });

    it('NM-S07: every message is a new object, so subscribers see each one', () => {
      const first = recordOwnerMessage(undefined, firstMessageAt);

      const second = recordOwnerMessage(first, firstMessageAt);

      expect(second).not.toBe(first);
      expect(second).toEqual(first);
    });
  });

  it('dismissing twice changes nothing', () => {
    const dismissed = dismissDowntimeEpisode(recordOwnerMessage(undefined, firstMessageAt));

    expect(dismissDowntimeEpisode(dismissed)).toBe(dismissed);
  });

  describe('shouldPresentDowntimeEpisode', () => {
    const episode = recordProcessExit(undefined, exit);

    it('presents an open episode for a visible, dead, idle team', () => {
      expect(shouldPresentDowntimeEpisode(episode, visibleDeadTeam)).toBe(true);
    });

    it('presents nothing without an episode (NM-S11)', () => {
      expect(shouldPresentDowntimeEpisode(undefined, visibleDeadTeam)).toBe(false);
    });

    it('does not present a dismissed episode until the owner writes again (NM-S20)', () => {
      const dismissed = dismissDowntimeEpisode(episode);

      expect(shouldPresentDowntimeEpisode(dismissed, visibleDeadTeam)).toBe(false);
      expect(
        shouldPresentDowntimeEpisode(
          recordOwnerMessage(dismissed, secondMessageAt),
          visibleDeadTeam
        )
      ).toBe(true);
    });

    it.each([
      ['the tab is not active (NM-S09)', { isTabActive: false }],
      ['the team is alive (NM-S10)', { isAlive: true }],
      ['a launch is running (NM-S10)', { isProvisioning: true }],
      ['the launch form is open (NM-S10)', { isLaunchDialogOpen: true }],
    ] satisfies [string, Partial<DowntimePresentationContext>][])(
      'waits while %s',
      (_name, patch) => {
        expect(shouldPresentDowntimeEpisode(episode, { ...visibleDeadTeam, ...patch })).toBe(false);
      }
    );
  });
});
