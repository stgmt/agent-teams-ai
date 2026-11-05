import type { TeamRunIdentity } from '../../contracts';

function sameRun(a: TeamRunIdentity, b: TeamRunIdentity): boolean {
  return (
    a.appInstanceId === b.appInstanceId &&
    a.dataRootFingerprint === b.dataRootFingerprint &&
    a.connectionGeneration === b.connectionGeneration &&
    a.teamName === b.teamName &&
    a.runId === b.runId
  );
}

export class LeadMemberStartAuthority {
  private readonly bindings = new Map<string, Readonly<TeamRunIdentity>>();

  bind(credential: string, run: TeamRunIdentity): void {
    if (!credential.trim()) throw new Error('Lead launch credential is required');
    if (this.bindings.has(credential)) throw new Error('Lead launch credential is already bound');
    if ([...this.bindings.values()].some((bound) => sameRun(bound, run)))
      throw new Error('Team run already has a lead launch credential');
    this.bindings.set(credential, Object.freeze({ ...run }));
  }

  resolve(credential: string): Readonly<TeamRunIdentity> {
    const run = this.bindings.get(credential);
    if (!run) throw new Error('Unauthorized lead member-start request');
    return run;
  }

  credentialFor(run: TeamRunIdentity): string {
    for (const [credential, bound] of this.bindings) {
      if (sameRun(bound, run)) return credential;
    }
    throw new Error('Unauthorized lead runtime launch');
  }

  revokeRun(run: TeamRunIdentity): void {
    for (const [credential, bound] of this.bindings) {
      if (sameRun(bound, run)) this.bindings.delete(credential);
    }
  }
}
