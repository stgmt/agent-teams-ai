/**
 * Composition for registry-backed canonical writes.
 *
 * The client resolves URL/token/timeouts lazily and fails closed, so a team
 * that has no spec binding never triggers token resolution at all.
 */

import { ExecutionTaskStore } from '../execution/ExecutionTaskStore';

import { RegistryTaskClient } from './RegistryTaskClient';
import { RegistryTeamTaskWriter } from './RegistryTeamTaskWriter';

import type { RegistryTaskGenesisSigner } from './RegistryTeamTaskWriter';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { RegistryRegistrationIdentity } from '@shared/types';

export interface RegistryTeamTaskWriterRequest {
  teamName: string;
  teamId: string;
  binding: TeamSpecBinding;
  expectedRegistrationIdentity?: RegistryRegistrationIdentity;
  signTaskGenesisAttestation?: RegistryTaskGenesisSigner;
}

export type RegistryTeamTaskWriterProvider = (
  request: RegistryTeamTaskWriterRequest
) => Promise<RegistryTeamTaskWriter>;

export const createRegistryTeamTaskWriter: RegistryTeamTaskWriterProvider = async ({
  teamName,
  teamId,
  binding,
  expectedRegistrationIdentity,
  signTaskGenesisAttestation,
}) => {
  const client = await RegistryTaskClient.create();
  return new RegistryTeamTaskWriter({
    teamName,
    teamId,
    binding,
    client,
    executionStore: new ExecutionTaskStore(),
    expectedRegistrationIdentity,
    signTaskGenesisAttestation,
  });
};
