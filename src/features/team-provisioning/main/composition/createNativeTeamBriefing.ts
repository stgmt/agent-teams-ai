import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from '@main/services/team/bootstrap/NativeAppManagedBootstrapContextBuilder';

import type { ConfiguredMemberLaunch } from '../../core/application/ports/MemberRuntimePorts';
import type { TeamMember } from '@shared/types';

const MAX_BRIEFING_CHARS = 18_000;

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
/**
 * Append the bound-specification recipe after the briefing text without ever
 * exceeding the launch limit. The recipe is load-bearing (it is the only place
 * a member learns the bound specs and the registry recipe), so the base text is
 * shortened instead of the recipe being dropped.
 */
function withSpecRecipe(base: string, recipe: string | undefined): string {
  if (!recipe?.trim()) return base.slice(0, MAX_BRIEFING_CHARS);
  const separator = '\n\n';
  const budget = MAX_BRIEFING_CHARS - recipe.length - separator.length;
  if (budget <= 0) return recipe.slice(0, MAX_BRIEFING_CHARS);
  return `${base.slice(0, budget)}${separator}${recipe}`;
}

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
    if (bootstrapped) return withSpecRecipe(bootstrapped, settings.specInstructions);

    const configured = settings.instructions?.trim();
    if (!configured) {
      throw new Error(`Member ${settings.memberName} has no briefing to launch with`);
    }
    // The launch artifacts accept at most this many characters; a long workflow or role
    // text must not turn a valid member into an unlaunchable one.
    return withSpecRecipe(configured, settings.specInstructions);
  };
}
