export interface ConfiguredTeamWorkspace {
  teamName: string;
  workingDirectory: string;
  worktreeName?: string;
}

export interface PreparedTeamWorkspace {
  workingDirectory: string;
  worktree?: Readonly<{
    baseRepoPath: string;
    branchName: string;
  }>;
}

export interface TeamWorkspacePort {
  prepareTeam(
    input: Readonly<ConfiguredTeamWorkspace>,
    signal: AbortSignal
  ): Promise<Readonly<PreparedTeamWorkspace>>;
}
