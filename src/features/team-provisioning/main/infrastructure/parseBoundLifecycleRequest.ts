import { AppContextMismatchError } from '@features/external-agent-connection/main';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export function parseBoundLifecycleRequest(
  input: unknown,
  owner: Readonly<AppConnectionContext>,
  extraFields: readonly string[] = []
): { teamName: string; fields: Readonly<Record<string, unknown>> } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('A bound lifecycle request is required');
  const value = input as Record<string, unknown>;
  const allowed = ['expectedContext', 'teamName', ...extraFields];
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key)))
    throw new TypeError(`Only ${allowed.join(', ')} are accepted`);
  const expected = value.expectedContext;
  if (
    !expected ||
    typeof expected !== 'object' ||
    Array.isArray(expected) ||
    !('appInstanceId' in expected) ||
    !('dataRootFingerprint' in expected) ||
    !('connectionGeneration' in expected) ||
    expected.appInstanceId !== owner.appInstanceId ||
    expected.dataRootFingerprint !== owner.dataRootFingerprint ||
    expected.connectionGeneration !== owner.connectionGeneration
  )
    throw new AppContextMismatchError();
  const team = validateTeamName(value.teamName);
  if (!team.valid || !team.value || team.value !== value.teamName)
    throw new TypeError(team.error ?? 'An exact teamName is required');
  return { teamName: team.value, fields: value };
}
