import { describe, expect, it } from 'vitest';

import { createTeamDowntimeStore } from '../teamDowntimeStore';

const exit = { exitCode: 1, occurredAt: '2026-10-24T05:48:27.000Z', cliLogsTail: 'boom' };

describe('teamDowntimeStore', () => {
  it('NM-S06: a recorded process exit opens an episode with code, time and log tail', () => {
    const store = createTeamDowntimeStore();

    store.getState().recordProcessExit('my-team', exit);

    expect(store.getState().episodes['my-team']).toEqual({
      exit,
      ownerMessageAt: null,
      dismissed: false,
    });
  });

  it('keeps episodes of different teams apart', () => {
    const store = createTeamDowntimeStore();

    store.getState().recordProcessExit('team-a', exit);
    store.getState().recordOwnerMessage('team-b', '2026-10-24T06:00:00.000Z');

    expect(Object.keys(store.getState().episodes).sort((a, b) => a.localeCompare(b))).toEqual([
      'team-a',
      'team-b',
    ]);
    expect(store.getState().episodes['team-b']).toEqual({
      exit: null,
      ownerMessageAt: '2026-10-24T06:00:00.000Z',
      dismissed: false,
    });
  });

  it('NM-S07: a message after a dismissed exit shows the notice again, with the exit kept', () => {
    const store = createTeamDowntimeStore();
    store.getState().recordProcessExit('team-a', exit);
    store.getState().dismiss('team-a');
    expect(store.getState().episodes['team-a']?.dismissed).toBe(true);

    store.getState().recordOwnerMessage('team-a', '2026-10-24T06:00:00.000Z');

    expect(store.getState().episodes['team-a']).toEqual({
      exit,
      ownerMessageAt: '2026-10-24T06:00:00.000Z',
      dismissed: false,
    });
  });

  it('NM-S07: two messages at the same instant still notify subscribers twice', () => {
    const store = createTeamDowntimeStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));

    store.getState().recordOwnerMessage('team-a', '2026-10-24T06:00:00.000Z');
    store.getState().dismiss('team-a');
    store.getState().recordOwnerMessage('team-a', '2026-10-24T06:00:00.000Z');

    expect(notifications).toBe(3);
    expect(store.getState().episodes['team-a']?.dismissed).toBe(false);
  });

  it('NM-S08: clear ends the episode so the next outage opens a new one', () => {
    const store = createTeamDowntimeStore();
    store.getState().recordProcessExit('team-a', exit);
    store.getState().dismiss('team-a');

    store.getState().clear('team-a');
    expect(store.getState().episodes['team-a']).toBeUndefined();

    store.getState().recordProcessExit('team-a', { ...exit, exitCode: 2 });
    expect(store.getState().episodes['team-a']?.dismissed).toBe(false);
    expect(store.getState().episodes['team-a']?.exit?.exitCode).toBe(2);
  });

  it('does not notify subscribers when there is nothing to change', () => {
    const store = createTeamDowntimeStore();
    let notifications = 0;
    store.subscribe(() => (notifications += 1));

    store.getState().clear('team-a');
    store.getState().dismiss('team-a');

    expect(notifications).toBe(0);
  });
});
