import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from '@main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';

import type { ConfiguredMemberLaunch } from '../../core/application/ports/MemberRuntimePorts';
import type { TeamMember } from '@shared/types';

export interface NativeTeamBriefingSources {
  /** Members recorded for the team, including ones the config no longer lists. */
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
}

/**
 * The briefing a member is launched with.
 *
 * Providers the app bootstraps itself get the same bounded, redacted text their
 * startup context was built from, so the hash recorded on the launch and the text the
 * member actually reads cannot drift. Other providers build their own prompt, and for
 * them the configured instructions are the briefing: they are what the member would
 * receive anyway, and inventing a second text here would describe a prompt nobody sends.
 */
export function createNativeTeamBriefing(
  sources: NativeTeamBriefingSources
): (settings: Readonly<ConfiguredMemberLaunch>) => Promise<string> {
  return async (settings) => {
    const teamName = settings.team.teamName;
    const members = await sources.readMembersMeta(teamName);
    const built = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
      teamName,
      cwd: settings.workingDirectory,
      members: [...members],
    });
    const bootstrapped = built.briefings.get(settings.memberName);
    if (bootstrapped) return bootstrapped;

    const configured = settings.instructions?.trim();
    if (!configured) {
      throw new Error(`Member ${settings.memberName} has no briefing to launch with`);
    }
    return configured;
  };
}
