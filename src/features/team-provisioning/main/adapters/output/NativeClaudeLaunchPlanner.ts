import { isAbsolute } from 'node:path';

import { getMemberColorByName } from '@shared/constants/memberColors';
import {
  buildTeamMemberMcpSettingSources,
  requiresStrictTeamMemberMcpConfig,
} from '@shared/utils/teamMemberMcpPolicy';

import { isNativeRuntimeProvider } from '../../infrastructure/nativeRuntimeProvider';
import { personalTaskListId } from '../../infrastructure/personalTaskListId';
import { rejectAfterOwnedCleanup } from '../../infrastructure/rejectAfterOwnedCleanup';
import { withoutParentGitSelection } from '../../infrastructure/workspaceEnvironment';

import { NativeRuntimeConnection } from './NativeRuntimeConnection';

import type { MemberProcessToken, OwnedProcessIdentity } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeRuntimeConnectionExpected } from './NativeRuntimeConnection';
import type { NodeMemberLaunchPlan, NodeMemberLaunchPlanner } from './NodeMemberRuntime';
import type { TeamMemberMcpPolicy } from '@shared/types';

export const APP_OWNED_TEAM_DISALLOWED_TOOLS = [
  'Agent',
  'Task',
  'TeamCreate',
  'TeamDelete',
  'mcp__agent-teams__team_create',
  'mcp__agent-teams__team_update',
  'mcp__agent-teams__team_launch',
  'mcp__agent-teams__team_stop',
  'mcp__agent-teams__team_trash',
].join(',');

export interface NativeProviderLaunch {
  executable: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  dispose?(): Promise<void>;
}

export interface NativeLaunchArtifacts {
  mcpConfigPath: string;
  bootstrapSpecPath?: string;
  userPromptPath?: string;
  eventsPath?: string;
  bootstrapProof?: Pick<
    NativeRuntimeConnectionExpected,
    'proofToken' | 'contextHash' | 'briefingHash' | 'boundaryMs'
  >;
  env: NodeJS.ProcessEnv;
  afterSpawn?(identity: Readonly<OwnedProcessIdentity>, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

export interface NativeClaudeLaunchPlannerPorts {
  prepareWorkspace(
    settings: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal
  ): Promise<Readonly<ConfiguredMemberLaunch>>;
  prepareProvider(
    settings: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal
  ): Promise<NativeProviderLaunch>;
  prepareArtifacts(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<NativeLaunchArtifacts>;
  /**
   * Whether a member is refused when the provider has no credential. Production turns
   * this on so a launch fails with the missing-access message instead of a member that
   * starts and silently never connects; planning-only callers leave it off.
   */
  requireProviderAuth?: boolean;
}

const RESERVED_FLAGS = new Set([
  '--print',
  '-p',
  '--input-format',
  '--output-format',
  '--verbose',
  '--team-bootstrap-spec',
  '--team-bootstrap-spec-path',
  '--team-bootstrap-user-prompt-file',
  '--teammate-runtime',
  '--teammate-mode',
  '--agent',
  '--agents',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--session-id',
  '--fork-session',
  '--agent-id',
  '--agent-name',
  '--agent-type',
  '--worktree',
  '-w',
  '--cwd',
  '--isolation',
  '--team-name',
  '--agent-color',
  '--parent-session-id',
  '--mcp-config',
  '--strict-mcp-config',
  '--setting-sources',
  '--disallowedTools',
  '--disallowed-tools',
  '--allowedTools',
  '--allowed-tools',
  '--tools',
  '--dangerously-skip-permissions',
  '--permission-mode',
  '--permission-prompt-tool',
]);

function assertIdentity(settings: ConfiguredMemberLaunch, token: MemberProcessToken): void {
  const run = settings.team;
  if (
    settings.memberName !== token.memberName ||
    run.appInstanceId !== token.appInstanceId ||
    run.dataRootFingerprint !== token.dataRootFingerprint ||
    run.connectionGeneration !== token.connectionGeneration ||
    run.teamName !== token.teamName ||
    run.runId !== token.runId ||
    (settings.role !== 'lead' && settings.role !== 'member')
  )
    throw new Error('Invalid native launch identity');
  if (!isNativeRuntimeProvider(settings.providerId))
    throw new Error('Provider requires a non-native runtime adapter');
}

function observeLeadBootstrap(
  line: string,
  stream: 'stdout' | 'stderr',
  token: MemberProcessToken
): 'connected' | null {
  if (stream !== 'stdout') return null;
  let event: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    event = value as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    event.type !== 'system' ||
    event.subtype !== 'team_bootstrap' ||
    event.team_name !== token.teamName ||
    event.run_id !== token.runId
  )
    return null;
  if (event.event === 'failed') {
    throw new Error(
      typeof event.reason === 'string' && event.reason.trim()
        ? event.reason
        : 'Native lead bootstrap failed'
    );
  }
  return event.event === 'completed' &&
    event.status === 'completed' &&
    Array.isArray(event.expected_members) &&
    event.expected_members.length === 0 &&
    Array.isArray(event.registered_members) &&
    event.registered_members.length === 0 &&
    Array.isArray(event.failed_members) &&
    event.failed_members.length === 0
    ? 'connected'
    : null;
}

export class NativeClaudeLaunchPlanner implements NodeMemberLaunchPlanner {
  constructor(private readonly ports: NativeClaudeLaunchPlannerPorts) {}

  async prepare(
    requested: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<NodeMemberLaunchPlan> {
    assertIdentity(requested, token);
    signal.throwIfAborted();
    const settings = await this.ports.prepareWorkspace(requested, signal);
    signal.throwIfAborted();
    assertIdentity(settings, token);
    if (!settings.taskLedgerProjectDirectory || !isAbsolute(settings.taskLedgerProjectDirectory))
      throw new Error('Native launch requires an absolute task ledger binding');
    const provider = await this.ports.prepareProvider(settings, signal);
    let artifacts: NativeLaunchArtifacts;
    try {
      signal.throwIfAborted();
      // Without a credential the runtime starts and then refuses the first turn, which
      // reaches the user as a member that silently never connects. Say it instead.
      if (
        this.ports.requireProviderAuth === true &&
        settings.providerId === 'anthropic' &&
        !provider.env.ANTHROPIC_API_KEY?.trim() &&
        !provider.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() &&
        !provider.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR?.trim()
      ) {
        throw new Error(
          'Claude access is not configured for teammates: sign in to Claude Code on this machine or set ANTHROPIC_API_KEY'
        );
      }
      if (
        !provider.executable.trim() ||
        provider.args.some((arg) => RESERVED_FLAGS.has(arg.split('=')[0]))
      ) {
        throw new Error('Provider launch contains a reserved lifecycle argument');
      }
      artifacts = await this.ports.prepareArtifacts(settings, token, signal);
    } catch (error) {
      return rejectAfterOwnedCleanup(error, async () => {
        await provider.dispose?.();
      });
    }
    const dispose = async (): Promise<void> => {
      const results = await Promise.allSettled([artifacts.dispose(), provider.dispose?.()]);
      const errors: unknown[] = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (errors.length)
        throw new AggregateError(errors, 'Owned native launch resources could not be released');
    };
    try {
      signal.throwIfAborted();
      const lead = settings.role === 'lead';
      if (
        !artifacts.mcpConfigPath ||
        (lead && !artifacts.bootstrapSpecPath) ||
        (!lead && (!artifacts.eventsPath || !artifacts.bootstrapProof))
      )
        throw new Error('Native runtime launch artifacts are incomplete');
      const policy: TeamMemberMcpPolicy | undefined = settings.mcpPolicy;
      const args = [
        ...(lead
          ? [
              '--print',
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              '--verbose',
              '--team-bootstrap-spec',
              artifacts.bootstrapSpecPath!,
              ...(artifacts.userPromptPath
                ? ['--team-bootstrap-user-prompt-file', artifacts.userPromptPath]
                : []),
            ]
          : [
              '--teammate-runtime',
              'headless',
              '--agent-id',
              `${token.memberName}@${token.teamName}`,
              '--agent-name',
              token.memberName,
              '--team-name',
              token.teamName,
              '--agent-color',
              getMemberColorByName(token.memberName),
              '--parent-session-id',
              token.runId,
              ...(settings.agentType ? ['--agent-type', settings.agentType] : []),
            ]),
        '--setting-sources',
        buildTeamMemberMcpSettingSources(policy),
        '--mcp-config',
        artifacts.mcpConfigPath,
        ...(requiresStrictTeamMemberMcpConfig(policy) ? ['--strict-mcp-config'] : []),
        '--disallowedTools',
        lead ? `${APP_OWNED_TEAM_DISALLOWED_TOOLS},SendMessage` : APP_OWNED_TEAM_DISALLOWED_TOOLS,
        ...(settings.skipPermissions !== false
          ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
        ...provider.args,
        ...(settings.resumeSessionId ? ['--resume', settings.resumeSessionId] : []),
      ];
      const env = withoutParentGitSelection({
        ...provider.env,
        ...artifacts.env,
        CLAUDE_CODE_TASK_LIST_ID: personalTaskListId(token),
        CLAUDE_CODE_ENABLE_TASKS: '1',
        CLAUDE_CODE_BOOTSTRAP_RUN_ID: token.runId,
      });
      // Only the scoped MCP child receives this capability; never the model CLI or its shell tools.
      delete env.AGENT_TEAMS_LEAD_START_CREDENTIAL;
      // These fields describe this launch only, never a parent process's workspace.
      for (const key of [
        // The registry credential belongs to the app MCP child; an inherited
        // value would mount a second, duplicate spec server in the agent.
        'OMP_SPEC_REGISTRY_URL',
        'OMP_SPEC_REGISTRY_TOKEN',
        'OMP_SPEC_REGISTRY_TOKEN_FILE',
        // The project selector rides with the credential: inherited alone it
        // points the spec-kit plugin at a corpus this team is not bound to.
        'OMP_SPEC_PROJECT',
        'CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR',
        'CLAUDE_CODE_TEAM_WORKTREE_PATH',
        'CLAUDE_CODE_TEAM_WORKTREE_BRANCH',
        'CLAUDE_CODE_TEAM_BASE_WORKSPACE_ROOT',
        'CLAUDE_CODE_TEAM_WORKTREE_DIRTY_WARNING',
      ])
        delete env[key];
      env.CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR = settings.taskLedgerProjectDirectory;
      if (settings.worktree)
        Object.assign(env, {
          CLAUDE_CODE_TEAM_WORKTREE_PATH: settings.workingDirectory,
          CLAUDE_CODE_TEAM_WORKTREE_BRANCH: settings.worktree.branchName,
          CLAUDE_CODE_TEAM_BASE_WORKSPACE_ROOT: settings.worktree.baseRepoPath,
        });
      if (!lead)
        Object.assign(env, {
          CLAUDE_CODE_TEAMMATE_RUNTIME: 'headless',
          CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH: artifacts.eventsPath,
          CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN: artifacts.bootstrapProof!.proofToken,
        });
      return {
        executable: provider.executable,
        args,
        cwd: settings.workingDirectory,
        env,
        connectionTimeoutMs: 120_000,
        observeOutput: (line, stream) => (lead ? observeLeadBootstrap(line, stream, token) : null),
        connection: lead
          ? undefined
          : new NativeRuntimeConnection({
              ...artifacts.bootstrapProof!,
              eventsPath: artifacts.eventsPath!,
              teamName: token.teamName,
              memberName: token.memberName,
              runId: token.runId,
            }),
        afterSpawn: artifacts.afterSpawn
          ? (identity, lifetime) => artifacts.afterSpawn!(identity, lifetime)
          : undefined,
        dispose,
      };
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
  }
}
