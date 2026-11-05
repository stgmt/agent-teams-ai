import type { MemberStartAdmission, TeamRunIdentity } from '../../../contracts';
import type { LeadMemberStartAuthority } from '../LeadMemberStartAuthority';

export interface ConfiguredMemberStartPort {
  start(team: TeamRunIdentity, memberName: string): Promise<MemberStartAdmission>;
}

export class StartBoundMember {
  constructor(
    private readonly authority: LeadMemberStartAuthority,
    private readonly members: ConfiguredMemberStartPort
  ) {}

  async execute(credential: string, input: unknown): Promise<MemberStartAdmission> {
    const team = this.authority.resolve(credential);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      !('memberName' in input) ||
      typeof input.memberName !== 'string' ||
      !input.memberName.trim() ||
      input.memberName !== input.memberName.trim()
    ) {
      throw new Error('Only a non-empty exact memberName is accepted');
    }
    return this.members.start(team, input.memberName);
  }
}
