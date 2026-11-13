import type { ResolvedTeamMember, TeamMemberSnapshot, TeamSummary } from '@shared/types';

export function generateUniqueName(sourceName: string, existingNames: string[]): string {
  const base = sourceName.replace(/-\d+$/, '');
  const existing = new Set(existingNames);
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

export function getRecentProjects(team: TeamSummary): string[] {
  const history = team.projectPathHistory;
  if (!history || history.length === 0) {
    return team.projectPath ? [team.projectPath] : [];
  }
  return history.slice(-3).reverse();
}

export function resolveLaunchDialogMembers(
  members: readonly TeamMemberSnapshot[]
): ResolvedTeamMember[] {
  return members.map((member) => {
    return {
      ...member,
      status: member.currentTaskId ? 'active' : 'idle',
      messageCount: 0,
      lastActiveAt: null,
    };
  });
}
