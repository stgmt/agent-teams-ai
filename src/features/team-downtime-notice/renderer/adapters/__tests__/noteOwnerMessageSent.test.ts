import { useStore } from '@renderer/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { teamDowntimeStore } from '../../state/teamDowntimeStore';
import { noteOwnerMessageSent } from '../noteOwnerMessageSent';

import type { TeamViewSnapshot } from '@shared/types';

const TEAM = 'my-team';

function seedTeamData(isAlive: boolean): void {
  // РИСК: в кэше только поле isAlive, которое читает проверка; остальной снимок команды не нужен.
  useStore.setState({
    teamDataCacheByName: { [TEAM]: { isAlive } as unknown as TeamViewSnapshot },
  });
}

function seedProvisioning(state: 'spawning' | 'ready' | 'disconnected'): void {
  useStore.setState({
    currentProvisioningRunIdByTeam: { [TEAM]: 'run-1' },
    provisioningRuns: {
      'run-1': {
        runId: 'run-1',
        teamName: TEAM,
        state,
        message: state,
        startedAt: '2026-10-24T05:00:00.000Z',
        updatedAt: '2026-10-24T05:00:01.000Z',
      },
    },
  });
}

describe('noteOwnerMessageSent', () => {
  beforeEach(() => {
    teamDowntimeStore.setState({ episodes: {} });
  });

  afterEach(() => {
    teamDowntimeStore.setState({ episodes: {} });
    useStore.setState({
      teamDataCacheByName: {},
      currentProvisioningRunIdByTeam: {},
      provisioningRuns: {},
    });
  });

  it('NM-S13: a message sent to a stopped, idle team opens an episode with the message time', () => {
    seedTeamData(false);

    noteOwnerMessageSent(TEAM);

    expect(teamDowntimeStore.getState().episodes[TEAM]).toMatchObject({
      exit: null,
      ownerMessageAt: expect.any(String),
      dismissed: false,
    });
  });

  it('NM-S12: a message after a stop by the user opens the notice', () => {
    seedTeamData(false);
    seedProvisioning('disconnected');

    noteOwnerMessageSent(TEAM);

    expect(teamDowntimeStore.getState().episodes[TEAM]).toMatchObject({
      exit: null,
      dismissed: false,
    });
  });

  it('NM-S14: a message sent to a live team opens nothing', () => {
    seedTeamData(true);

    noteOwnerMessageSent(TEAM);

    expect(teamDowntimeStore.getState().episodes[TEAM]).toBeUndefined();
  });

  it('opens nothing while a launch is running', () => {
    seedTeamData(false);
    seedProvisioning('spawning');

    noteOwnerMessageSent(TEAM);

    expect(teamDowntimeStore.getState().episodes[TEAM]).toBeUndefined();
  });

  it('opens nothing when the liveness of the team is not known yet', () => {
    noteOwnerMessageSent(TEAM);

    expect(teamDowntimeStore.getState().episodes[TEAM]).toBeUndefined();
  });

  it('NM-S07: a message after a dismissed notice shows it again, every time', () => {
    seedTeamData(false);
    teamDowntimeStore.getState().recordProcessExit(TEAM, {
      exitCode: 1,
      occurredAt: '2026-10-24T05:48:27.000Z',
    });
    teamDowntimeStore.getState().dismiss(TEAM);
    expect(teamDowntimeStore.getState().episodes[TEAM]?.dismissed).toBe(true);

    noteOwnerMessageSent(TEAM);
    expect(teamDowntimeStore.getState().episodes[TEAM]).toMatchObject({
      exit: { exitCode: 1 },
      dismissed: false,
    });

    teamDowntimeStore.getState().dismiss(TEAM);
    noteOwnerMessageSent(TEAM);
    expect(teamDowntimeStore.getState().episodes[TEAM]?.dismissed).toBe(false);
  });
});
