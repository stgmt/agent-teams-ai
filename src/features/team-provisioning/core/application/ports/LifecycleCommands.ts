import type { MemberStartAdmission, TeamRunIdentity } from '../../../contracts';

export interface LifecycleCommands {
  launch(input: unknown): Promise<Readonly<{ run: Readonly<TeamRunIdentity> }>>;
  stop(input: unknown): Promise<void>;
  restartMember(input: unknown): Promise<MemberStartAdmission>;
  skipMember(input: unknown): Promise<void>;
}
