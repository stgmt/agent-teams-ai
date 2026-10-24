import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useStore } from '@renderer/store';
import { EMPTY_TEAM_MESSAGES_CACHE_ENTRY } from '@renderer/store/team/teamMessagesCache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { teamDowntimeStore } from '../../state/teamDowntimeStore';
import { useTeamNotRunningNotice } from '../useTeamNotRunningNotice';

import type { InboxMessage } from '@shared/types';

type NoticeParams = Parameters<typeof useTeamNotRunningNotice>[0];
type Notice = ReturnType<typeof useTeamNotRunningNotice>;

const TEAM = 'my-team';
const exit = { exitCode: 1, occurredAt: '2026-10-24T05:48:27.000Z', cliLogsTail: 'boom' };

const deadTeam: Omit<NoticeParams, 'onLaunch'> = {
  teamName: TEAM,
  isAlive: false,
  isProvisioning: false,
  isLaunchDialogOpen: false,
  isTabActive: true,
};

function ownerMessage(to: string, read: boolean, id: string): InboxMessage {
  return {
    from: 'user',
    to,
    text: 'hello',
    timestamp: '2026-10-24T05:49:00.000Z',
    read,
    messageId: id,
    source: 'user_sent',
  };
}

describe('useTeamNotRunningNotice', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let latest: Notice;
  const onLaunch = vi.fn();

  async function render(patch: Partial<NoticeParams> = {}): Promise<void> {
    function Probe(): null {
      latest = useTeamNotRunningNotice({ ...deadTeam, onLaunch, ...patch });
      return null;
    }
    await act(async () => root.render(<Probe />));
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    onLaunch.mockReset();
    teamDowntimeStore.setState({ episodes: {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    teamDowntimeStore.setState({ episodes: {} });
    useStore.setState({ teamMessagesByName: {} });
    vi.unstubAllGlobals();
  });

  it('NM-S11: stays closed when no outage was witnessed in this session', async () => {
    await render();

    expect(latest.open).toBe(false);
  });

  it('NM-S06: opens for a witnessed process exit of a visible, dead, idle team', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);

    await render();

    expect(latest.open).toBe(true);
    expect(latest.episode).toMatchObject({ exit: { exitCode: 1 }, ownerMessageAt: null });
  });

  it('NM-S09: waits for the tab to become active and then opens once', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);

    await render({ isTabActive: false });
    expect(latest.open).toBe(false);

    await render({ isTabActive: true });
    expect(latest.open).toBe(true);
  });

  it('NM-S10: stays closed while the launch form is open or a launch runs', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);

    await render({ isLaunchDialogOpen: true });
    expect(latest.open).toBe(false);

    await render({ isProvisioning: true });
    expect(latest.open).toBe(false);
  });

  it('NM-S10: closes itself and ends the episode when the team becomes alive', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);
    await render();
    expect(latest.open).toBe(true);

    await render({ isAlive: true });

    expect(latest.open).toBe(false);
    expect(teamDowntimeStore.getState().episodes[TEAM]).toBeUndefined();
  });

  it('NM-S20: closing dismisses the episode and the notice does not come back', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);
    await render();

    await act(async () => latest.onClose());

    expect(latest.open).toBe(false);
    expect(teamDowntimeStore.getState().episodes[TEAM]?.dismissed).toBe(true);
  });

  it('NM-S07: an owner message after Close opens the notice again', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);
    await render();
    await act(async () => latest.onClose());
    expect(latest.open).toBe(false);

    await act(async () =>
      teamDowntimeStore.getState().recordOwnerMessage(TEAM, '2026-10-24T05:51:00.000Z')
    );

    expect(latest.open).toBe(true);
    expect(latest.episode).toMatchObject({
      exit: { exitCode: 1 },
      ownerMessageAt: '2026-10-24T05:51:00.000Z',
    });
  });

  it('NM-S13: an owner message alone opens the notice without any exit', async () => {
    await act(async () =>
      teamDowntimeStore.getState().recordOwnerMessage(TEAM, '2026-10-24T05:51:00.000Z')
    );

    await render();

    expect(latest.open).toBe(true);
    expect(latest.episode?.exit).toBeNull();
  });

  it('NM-S19: Launch dismisses the notice and calls the host launch action once', async () => {
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);
    await render();

    await act(async () => latest.onLaunch());

    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(teamDowntimeStore.getState().episodes[TEAM]?.dismissed).toBe(true);

    // The launch form is cancelled: the notice must not return for the same outage.
    await render({ isLaunchDialogOpen: false });
    expect(latest.open).toBe(false);
  });

  it('NM-S18: counts the owner messages that are still waiting for delivery', async () => {
    useStore.setState({
      teamMessagesByName: {
        [TEAM]: {
          ...EMPTY_TEAM_MESSAGES_CACHE_ENTRY,
          canonicalMessages: [
            ownerMessage('team-lead', false, 'm1'),
            ownerMessage('alice', false, 'm2'),
            ownerMessage('team-lead', true, 'm3'),
          ],
        },
      },
    });
    teamDowntimeStore.getState().recordProcessExit(TEAM, exit);

    await render();

    expect(latest.queuedCount).toBe(2);
  });
});
