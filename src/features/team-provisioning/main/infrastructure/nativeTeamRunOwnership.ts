import type { TeamRunIdentity } from '../../contracts';

export function isNativeTeamRunOwner(value: unknown, run: TeamRunIdentity): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    identity.appInstanceId === run.appInstanceId &&
    identity.dataRootFingerprint === run.dataRootFingerprint &&
    identity.connectionGeneration === run.connectionGeneration &&
    identity.teamName === run.teamName &&
    identity.runId === run.runId
  );
}
