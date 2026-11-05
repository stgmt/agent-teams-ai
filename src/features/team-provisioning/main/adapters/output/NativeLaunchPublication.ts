import {
  captureTeamStopIntent,
  TeamLaunchStateStore,
} from '@main/services/team/TeamLaunchStateStore';

import type { TeamRunIdentity } from '../../../contracts';

/** Publishes native ownership before any member lane can start. */
export class NativeLaunchPublication {
  private readonly store: TeamLaunchStateStore;
  private readonly guards = new Map<string, () => boolean>();

  constructor(private readonly teamsRoot: string) {
    this.store = new TeamLaunchStateStore(teamsRoot);
  }

  async begin(
    run: Readonly<TeamRunIdentity>,
    _members: string[],
    signal: AbortSignal
  ): Promise<void> {
    const guard = captureTeamStopIntent(run.teamName, this.teamsRoot);
    const accepted = await this.store.beginNativeLaunch(
      run.teamName,
      run.runId,
      () => !signal.aborted && guard()
    );
    if (!accepted) throw new Error('Native launch publication was not confirmed');
    this.guards.set(JSON.stringify([run.teamName, run.runId]), guard);
  }

  async retire(run: Readonly<TeamRunIdentity>): Promise<void> {
    const key = JSON.stringify([run.teamName, run.runId]);
    const guard = this.guards.get(key);
    if (!guard) return;
    try {
      // A Stop already admitted in this process owns the eventual marker.
      if (guard()) await this.store.retireNativeLaunch(run.teamName, run.runId, guard);
    } finally {
      this.guards.delete(key);
    }
  }
}
