import type {
  MemberLifecycleSnapshot,
  MemberProcessToken,
  OwnedProcessIdentity,
  TeamRunIdentity,
} from '../../contracts';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export function sameOwner(a: AppConnectionContext, b: AppConnectionContext): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration
  );
}

export function sameIdentity(a: TeamRunIdentity, b: Readonly<TeamRunIdentity>): boolean {
  return sameOwner(a, b) && a.teamName === b.teamName && a.runId === b.runId;
}

export function sameProcess(
  a: Readonly<OwnedProcessIdentity> | null,
  b: OwnedProcessIdentity
): boolean {
  return a !== null && a.pid === b.pid && a.birthId === b.birthId;
}

export function assertMemberProcessAuthority(
  member: Readonly<MemberLifecycleSnapshot> | undefined,
  token: Readonly<MemberProcessToken>,
  identity: Readonly<OwnedProcessIdentity>
): void {
  if (
    !member ||
    member.desired !== 'running' ||
    member.generation !== token.generation ||
    member.operationId !== token.operationId ||
    (member.process ? !sameProcess(member.process, identity) : member.phase !== 'starting')
  )
    throw new Error('Native SDK member generation/process authority refused');
}
