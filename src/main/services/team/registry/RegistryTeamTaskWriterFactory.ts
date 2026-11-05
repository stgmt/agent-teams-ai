/**
 * Composition for registry-backed canonical writes.
 *
 * The client resolves URL/token/timeouts lazily and fails closed, so a team
 * that has no spec binding never triggers token resolution at all.
 */

import { ExecutionTaskStore } from '../execution/ExecutionTaskStore';

import { RegistryTaskClient } from './RegistryTaskClient';
import { RegistryTeamTaskWriter } from './RegistryTeamTaskWriter';

import type { TeamSpecBinding } from './TeamSpecBinding';

export interface RegistryTeamTaskWriterRequest {
  teamName: string;
  binding: TeamSpecBinding;
}

export type RegistryTeamTaskWriterProvider = (
  request: RegistryTeamTaskWriterRequest
) => Promise<RegistryTeamTaskWriter>;

export const createRegistryTeamTaskWriter: RegistryTeamTaskWriterProvider = async ({
  teamName,
  binding,
}) => {
  const client = await RegistryTaskClient.create();
  return new RegistryTeamTaskWriter({
    teamName,
    binding,
    client,
    executionStore: new ExecutionTaskStore(),
  });
};
