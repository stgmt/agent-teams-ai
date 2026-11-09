import { RegistryTaskClient } from './registry/RegistryTaskClient';
import { TeamMetaStore } from './TeamMetaStore';

import type { RegistryRegistrationIdentity, TeamSpecBinding } from '@shared/types';

export interface TeamRegistryRegistrationClient {
  getRegistrationIdentity(
    project: string,
    requestId: string
  ): Promise<RegistryRegistrationIdentity>;
  registerTeam(
    project: string,
    requestId: string,
    expected: RegistryRegistrationIdentity
  ): Promise<{
    teamId: string;
    bindings: TeamSpecBinding[];
  }>;
}

/** Registers once using a durable request and server-authenticated identity fence. */
export class TeamRegistryRegistration {
  constructor(
    private readonly metadata = new TeamMetaStore(),
    private readonly clientFactory: () => Promise<TeamRegistryRegistrationClient> = () =>
      RegistryTaskClient.create(),
    private readonly teamsBasePath?: string
  ) {}

  async register(teamName: string, project: string): Promise<{ teamId: string }> {
    const reservation = await this.metadata.prepareRegistryRegistration(
      teamName,
      project,
      this.teamsBasePath
    );
    const client = await this.clientFactory();
    const identity = await client.getRegistrationIdentity(project, reservation.requestId);
    await this.metadata.fenceRegistryRegistration(
      teamName,
      project,
      reservation.requestId,
      identity,
      this.teamsBasePath
    );
    if (reservation.teamId) return { teamId: reservation.teamId };
    // A timeout or broken response remains unknown; a later call replays only
    // the same persisted request with the same verified store/principal fence.
    const result = await client.registerTeam(project, reservation.requestId, identity);
    await this.metadata.recordRegistryRegistration(
      teamName,
      project,
      reservation.requestId,
      identity,
      result.teamId,
      this.teamsBasePath
    );
    return { teamId: result.teamId };
  }
}
