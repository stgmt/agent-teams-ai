// @vitest-environment node
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { NativeClaudeLaunchPlanner } from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeLaunchPlanner';

import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';
import type { NativeProviderLaunch } from '../../../../src/features/team-provisioning/main/adapters/output/NativeClaudeLaunchPlanner';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};
const token = { ...run, memberName: 'team-lead', generation: 1, operationId: 'TEST-start' };
const settings = {
  team: run,
  memberName: 'team-lead',
  role: 'lead' as const,
  configurationRevision: 'TEST-revision',
  providerId: 'anthropic',
  model: 'TEST-model',
  effort: 'high',
  workingDirectory: process.cwd(),
  taskLedgerProjectDirectory: join(process.cwd(), 'TEST-ledger'),
  instructions: 'TEST instructions',
};

function setup() {
  const artifacts = {
    mcpConfigPath: 'TEST-mcp.json',
    bootstrapSpecPath: 'TEST-bootstrap.json',
    userPromptPath: 'TEST-prompt.txt',
    eventsPath: 'TEST-events.jsonl',
    bootstrapProof: {
      proofToken: 'TEST-proof',
      contextHash: 'TEST-context',
      briefingHash: 'TEST-briefing',
      boundaryMs: Date.now(),
    },
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'TEST-token' },
    dispose: vi.fn(() => Promise.resolve()),
  };
  const prepareArtifacts = vi.fn(() => Promise.resolve(artifacts));
  const prepareProvider = vi.fn(
    (): Promise<NativeProviderLaunch> =>
      Promise.resolve({
        executable: 'TEST-claude.exe',
        env: { TEST_AUTH: 'TEST-secret', CLAUDE_CODE_OAUTH_TOKEN: 'TEST-token' },
        args: ['--model', 'TEST-model', '--effort', 'high'],
      })
  );
  const prepareWorkspace = vi.fn((launch: Readonly<ConfiguredMemberLaunch>) =>
    Promise.resolve(launch)
  );
  const planner = new NativeClaudeLaunchPlanner({
    prepareWorkspace,
    prepareProvider,
    prepareArtifacts,
  });
  return { planner, prepareWorkspace, prepareArtifacts, prepareProvider, artifacts };
}

function bootstrap(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'system',
    subtype: 'team_bootstrap',
    run_id: run.runId,
    team_name: run.teamName,
    event: 'completed',
    status: 'completed',
    expected_members: [],
    registered_members: [],
    failed_members: [],
    ...patch,
  });
}

describe('native Claude launch planning with app-owned roster and scoped tools', () => {
  it('refuses a member whose provider has no credential when the application requires access', async () => {
    const guarded = new NativeClaudeLaunchPlanner({
      prepareWorkspace: (launch) => Promise.resolve(launch),
      prepareProvider: () =>
        Promise.resolve({ executable: 'TEST-claude.exe', env: {}, args: [] }),
      prepareArtifacts: () =>
        Promise.resolve({
          mcpConfigPath: 'TEST-mcp.json',
          bootstrapSpecPath: 'TEST-bootstrap.json',
          eventsPath: 'TEST-events.jsonl',
          bootstrapProof: { proofToken: 'TEST-proof', contextHash: 'c', briefingHash: 'b', boundaryMs: 1 },
          env: {},
          dispose: () => Promise.resolve(),
        }),
      requireProviderAuth: true,
    });
    await expect(guarded.prepare(settings, token, new AbortController().signal)).rejects.toThrow(
      'Claude access is not configured'
    );
  });

  it('resumes the captured session instead of starting a new one', async () => {
    const { planner } = setup();
    const plan = await planner.prepare(
      { ...settings, resumeSessionId: 'TEST-session' },
      token,
      new AbortController().signal
    );
    const index = plan.args.indexOf('--resume');
    expect(index).toBeGreaterThan(-1);
    expect(plan.args[index + 1]).toBe('TEST-session');
  });

  it('prepares a lead-only bootstrap, preserves selected provider arguments and denies roster changes', async () => {
    const { planner, prepareArtifacts } = setup();
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    expect(plan.executable).toBe('TEST-claude.exe');
    expect(plan.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--input-format',
        'stream-json',
        '--team-bootstrap-spec',
        'TEST-bootstrap.json',
        '--team-bootstrap-user-prompt-file',
        'TEST-prompt.txt',
        '--model',
        'TEST-model',
        '--effort',
        'high',
      ])
    );
    const denied = plan.args[plan.args.indexOf('--disallowedTools') + 1].split(',');
    expect(denied).toEqual([
      'Agent',
      'Task',
      'TeamCreate',
      'TeamDelete',
      'mcp__agent-teams__team_create',
      'mcp__agent-teams__team_update',
      'mcp__agent-teams__team_launch',
      'mcp__agent-teams__team_stop',
      'mcp__agent-teams__team_trash',
      'SendMessage',
    ]);
    expect(prepareArtifacts).toHaveBeenCalledWith(settings, token, expect.any(AbortSignal));
    expect(plan.env).toMatchObject({
      TEST_AUTH: 'TEST-secret',
      CLAUDE_CODE_BOOTSTRAP_RUN_ID: run.runId,
    });
    expect(plan.env.AGENT_TEAMS_LEAD_START_CREDENTIAL).toBeUndefined();
    expect(plan.observeOutput!(bootstrap(), 'stdout')).toBe('connected');
    for (const patch of [
      { run_id: 'old' },
      { team_name: 'foreign' },
      { status: 'partial_success' },
      { expected_members: ['builder'] },
    ]) {
      expect(plan.observeOutput!(bootstrap(patch), 'stdout')).toBeNull();
    }
    expect(plan.observeOutput!(bootstrap(), 'stderr')).toBeNull();
  });

  it.each(['anthropic', 'codex', 'gemini'])(
    'denies native SendMessage before a %s lead can bypass app-owned publication, without disabling member messaging',
    async (providerId) => {
      const { planner } = setup();
      const lead = await planner.prepare(
        { ...settings, providerId },
        token,
        new AbortController().signal
      );
      const member = await planner.prepare(
        { ...settings, providerId, role: 'member', memberName: 'builder' },
        { ...token, memberName: 'builder' },
        new AbortController().signal
      );
      const deniedLead = lead.args[lead.args.indexOf('--disallowedTools') + 1].split(',');
      const deniedMember = member.args[member.args.indexOf('--disallowedTools') + 1].split(',');
      expect(deniedLead).toContain('SendMessage');
      expect(deniedMember).not.toContain('SendMessage');
      expect(deniedLead).not.toContain('mcp__agent-teams__message_send');
      expect(deniedMember).toEqual(deniedLead.filter((tool) => tool !== 'SendMessage'));
      for (const tool of ['TodoWrite', 'TaskCreate', 'TaskUpdate']) {
        expect(deniedLead).not.toContain(tool);
        expect(deniedMember).not.toContain(tool);
      }
    }
  );

  it('never gives the agent CLI a registry credential, even when the parent has one', async () => {
    const previous = {
      OMP_SPEC_REGISTRY_URL: process.env.OMP_SPEC_REGISTRY_URL,
      OMP_SPEC_REGISTRY_TOKEN: process.env.OMP_SPEC_REGISTRY_TOKEN,
    };
    process.env.OMP_SPEC_REGISTRY_URL = 'http://127.0.0.1:8650/mcp';
    process.env.OMP_SPEC_REGISTRY_TOKEN = 'TEST-provider-token';
    try {
      const { planner, prepareProvider } = setup();
      prepareProvider.mockResolvedValue({
        executable: 'TEST-claude.exe',
        env: {
          TEST_AUTH: 'TEST-secret',
          OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
          OMP_SPEC_REGISTRY_TOKEN: 'TEST-provider-token',
          OMP_SPEC_PROJECT: 'OTHER/project',
        },
        args: [],
      });
      const plan = await planner.prepare(settings, token, new AbortController().signal);
      expect(plan.env).not.toHaveProperty('OMP_SPEC_REGISTRY_URL');
      expect(plan.env).not.toHaveProperty('OMP_SPEC_REGISTRY_TOKEN');
      expect(plan.env).not.toHaveProperty('OMP_SPEC_REGISTRY_TOKEN_FILE');
      // The selector travels with the credential: alone it points the plugin at
      // a corpus this team is not bound to.
      expect(plan.env).not.toHaveProperty('OMP_SPEC_PROJECT');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('isolates personal task lists by root, team and member while keeping restart identity stable', async () => {
    const { planner, prepareProvider, artifacts } = setup();
    const foreignEnv = {
      CLAUDE_CODE_TASK_LIST_ID: 'TEST-foreign',
      CLAUDE_CODE_ENABLE_TASKS: '0',
    };
    prepareProvider.mockResolvedValue({
      executable: 'TEST-claude.exe',
      args: [],
      env: foreignEnv,
    });
    Object.assign(artifacts.env, foreignEnv);
    const signal = new AbortController().signal;
    const lead = await planner.prepare(settings, token, signal);
    const restartedToken = {
      ...token,
      appInstanceId: 'TEST-restarted-app',
      runId: 'TEST-restarted-run',
      connectionGeneration: 2,
      generation: 2,
      operationId: 'TEST-restarted-operation',
    };
    const restarted = await planner.prepare(
      { ...settings, team: restartedToken },
      restartedToken,
      signal
    );
    const member = await planner.prepare(
      { ...settings, memberName: 'builder', role: 'member' },
      { ...token, memberName: 'builder' },
      signal
    );
    const otherRoot = { ...token, dataRootFingerprint: 'TEST-other-root' };
    const otherTeam = { ...token, teamName: 'TEST-other-team' };
    const rootPlan = await planner.prepare({ ...settings, team: otherRoot }, otherRoot, signal);
    const teamPlan = await planner.prepare({ ...settings, team: otherTeam }, otherTeam, signal);
    const expectedId =
      'agts-personal-v1-5ce9099203a4b576854d52018fd5e6a8ba1df79a20a3e35a61276c08c951f215';
    expect(lead.env.CLAUDE_CODE_TASK_LIST_ID).toBe(expectedId);
    expect(restarted.env.CLAUDE_CODE_TASK_LIST_ID).toBe(expectedId);
    const ids = [lead, member, rootPlan, teamPlan].map((plan) => plan.env.CLAUDE_CODE_TASK_LIST_ID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const plan of [lead, restarted, member, rootPlan, teamPlan]) {
      expect(plan.env).toMatchObject({
        CLAUDE_CODE_ENABLE_TASKS: '1',
      });
      expect(plan.env.CLAUDE_CODE_TASK_LIST_ID).toMatch(/^agts-personal-v1-[a-f0-9]{64}$/);
    }
  });

  it('reports an explicit failed lead bootstrap only from the current stdout run', async () => {
    const { planner } = setup();
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    const failed = bootstrap({ event: 'failed', reason: 'TEST native lead attachment refused' });
    expect(() => plan.observeOutput!(failed, 'stdout')).toThrow(
      'TEST native lead attachment refused'
    );
    expect(plan.observeOutput!(failed, 'stderr')).toBeNull();
    expect(
      plan.observeOutput!(
        bootstrap({ event: 'failed', run_id: 'TEST-old', reason: 'TEST stale' }),
        'stdout'
      )
    ).toBeNull();
    expect(
      plan.observeOutput!(
        bootstrap({ event: 'failed', team_name: 'TEST-foreign', reason: 'TEST foreign' }),
        'stdout'
      )
    ).toBeNull();
  });

  it.each(['lead', 'member'] as const)(
    'plans a configured Gemini %s through the native runtime without a second orchestration route',
    async (role) => {
      const { planner } = setup();
      const memberName = role === 'lead' ? 'team-lead' : 'builder';
      const plan = await planner.prepare(
        { ...settings, memberName, role, providerId: 'gemini' },
        { ...token, memberName },
        new AbortController().signal
      );
      expect(plan.args).toContain(role === 'lead' ? '--team-bootstrap-spec' : '--teammate-runtime');
    }
  );

  it('starts a configured teammate directly without bootstrap spawning or a lead credential', async () => {
    const { planner } = setup();
    const member = {
      ...settings,
      memberName: 'builder',
      role: 'member' as const,
      agentType: 'builder',
    };
    const memberToken = { ...token, memberName: 'builder' };
    const plan = await planner.prepare(member, memberToken, new AbortController().signal);
    expect(plan.args).toEqual(
      expect.arrayContaining([
        '--teammate-runtime',
        'headless',
        '--agent-name',
        'builder',
        '--agent-id',
        'builder@TEST-team',
        '--team-name',
        'TEST-team',
        '--mcp-config',
        'TEST-mcp.json',
      ])
    );
    expect(plan.args).not.toContain('--team-bootstrap-spec');
    expect(plan.env).toMatchObject({
      CLAUDE_CODE_TEAMMATE_RUNTIME: 'headless',
      CLAUDE_CODE_TEAMMATE_RUNTIME_EVENTS_PATH: 'TEST-events.jsonl',
      CLAUDE_CODE_BOOTSTRAP_PROOF_TOKEN: 'TEST-proof',
    });
    expect(plan.connection).toBeDefined();
    expect(plan.observeOutput!(bootstrap(), 'stdout')).toBeNull();
  });

  it('resolves the workspace before provider and private artifacts, and spawns in that exact workspace', async () => {
    const { planner, prepareWorkspace, prepareProvider, prepareArtifacts } = setup();
    const resolved = {
      ...settings,
      workingDirectory: 'TEST-isolated-workspace',
      taskLedgerProjectDirectory: join(process.cwd(), 'TEST-lead-ledger'),
      worktree: {
        baseRepoPath: 'TEST-base-repo',
        branchName: 'TEST-task-branch',
      },
    };
    prepareWorkspace.mockResolvedValueOnce(resolved);
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    expect(prepareWorkspace).toHaveBeenCalledWith(settings, expect.any(AbortSignal));
    expect(prepareProvider).toHaveBeenCalledWith(resolved, expect.any(AbortSignal));
    expect(prepareArtifacts).toHaveBeenCalledWith(resolved, token, expect.any(AbortSignal));
    expect(plan.cwd).toBe(resolved.workingDirectory);
    expect(plan.env).toMatchObject({
      CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR: join(process.cwd(), 'TEST-lead-ledger'),
      CLAUDE_CODE_TEAM_WORKTREE_PATH: resolved.workingDirectory,
      CLAUDE_CODE_TEAM_WORKTREE_BRANCH: 'TEST-task-branch',
      CLAUDE_CODE_TEAM_BASE_WORKSPACE_ROOT: 'TEST-base-repo',
    });
  });

  it('never borrows a parent process worktree identity for a shared-workspace launch', async () => {
    const { planner, prepareProvider } = setup();
    prepareProvider.mockResolvedValueOnce({
      executable: 'TEST',
      args: [],
      env: {
        CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR: 'TEST-foreign-ledger',
        CLAUDE_CODE_TEAM_WORKTREE_PATH: 'TEST-foreign-worktree',
        CLAUDE_CODE_TEAM_WORKTREE_BRANCH: 'TEST-foreign-branch',
        CLAUDE_CODE_TEAM_BASE_WORKSPACE_ROOT: 'TEST-foreign-base',
        CLAUDE_CODE_TEAM_WORKTREE_DIRTY_WARNING: 'TEST-foreign-warning',
        GIT_DIR: 'TEST-foreign-git-dir',
        GIT_COMMON_DIR: 'TEST-foreign-common',
        GIT_WORK_TREE: 'TEST-foreign-work-tree',
        GIT_INDEX_FILE: 'TEST-foreign-index',
      },
    });
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    expect(Object.keys(plan.env).filter((key) => key.includes('WORKTREE'))).toEqual([]);
    expect(plan.env.CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR).toBe(settings.taskLedgerProjectDirectory);
    for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
      expect(plan.env[key]).toBeUndefined();
  });

  it('passes the exact shared-workspace ledger even when provider preparation contains a foreign parent override', async () => {
    const { planner, prepareWorkspace, prepareProvider } = setup();
    prepareWorkspace.mockResolvedValueOnce({
      ...settings,
      taskLedgerProjectDirectory: join(process.cwd(), 'TEST-team-ledger'),
    });
    prepareProvider.mockResolvedValueOnce({
      executable: 'TEST',
      args: [],
      env: {
        CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR: 'TEST-foreign-ledger',
        CLAUDE_CODE_OAUTH_TOKEN: 'TEST-token',
      },
    });
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    expect(plan.env.CLAUDE_CODE_TASK_LEDGER_PROJECT_DIR).toBe(
      join(process.cwd(), 'TEST-team-ledger')
    );
    expect(plan.env.CLAUDE_CODE_TEAM_WORKTREE_PATH).toBeUndefined();
  });

  it.each([undefined, 'relative'])(
    'refuses an absent or invalid ledger binding (%s) before provider allocation',
    async (taskLedgerProjectDirectory) => {
      const { planner, prepareWorkspace, prepareProvider, prepareArtifacts } = setup();
      prepareWorkspace.mockResolvedValueOnce({ ...settings, taskLedgerProjectDirectory });
      await expect(planner.prepare(settings, token, new AbortController().signal)).rejects.toThrow(
        'absolute task ledger'
      );
      expect(prepareProvider).not.toHaveBeenCalled();
      expect(prepareArtifacts).not.toHaveBeenCalled();
    }
  );

  it('does not prepare provider resources when workspace preparation is cancelled', async () => {
    const { planner, prepareWorkspace, prepareProvider, prepareArtifacts } = setup();
    const abort = new AbortController();
    prepareWorkspace.mockImplementationOnce(() => {
      abort.abort();
      return Promise.resolve(settings);
    });
    await expect(planner.prepare(settings, token, abort.signal)).rejects.toThrow();
    expect(prepareProvider).not.toHaveBeenCalled();
    expect(prepareArtifacts).not.toHaveBeenCalled();
  });

  it('rejects forged identities, unsupported providers and overridden lifecycle arguments before preparing resources', async () => {
    const { planner, prepareProvider, prepareArtifacts } = setup();
    await expect(
      planner.prepare(settings, { ...token, runId: 'foreign' }, new AbortController().signal)
    ).rejects.toThrow('identity');
    await expect(
      planner.prepare({ ...settings, providerId: 'opencode' }, token, new AbortController().signal)
    ).rejects.toThrow('native');
    expect(prepareProvider).not.toHaveBeenCalled();
    expect(prepareArtifacts).not.toHaveBeenCalled();
    for (const args of [
      ['--team-name', 'foreign'],
      ['--team-name=foreign'],
      ['--teammate-mode', 'in-process'],
      ['--resume', 'foreign-session'],
      ['--agent', 'unconfigured-agent'],
      ['--worktree', 'unowned-worktree'],
      ['-w', 'unowned-worktree'],
      ['--cwd=foreign-workspace'],
      ['--isolation', 'worktree'],
      ['--team-bootstrap-spec-path', 'other.json'],
      ['--disallowedTools', ''],
      ['--disallowedTools=Agent'],
      ['--allowedTools', 'SendMessage'],
      ['--tools=SendMessage'],
    ]) {
      prepareProvider.mockResolvedValueOnce({
        executable: 'TEST',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'TEST-token' },
        args,
      });
      await expect(planner.prepare(settings, token, new AbortController().signal)).rejects.toThrow(
        'reserved'
      );
    }
    expect(prepareArtifacts).not.toHaveBeenCalled();
  });

  it('disposes owned artifacts when cancelled after their creation and never leaks a credential to the CLI environment', async () => {
    const { planner, prepareArtifacts, artifacts, prepareProvider } = setup();
    const abort = new AbortController();
    prepareArtifacts.mockImplementationOnce(() => {
      abort.abort();
      return Promise.resolve(artifacts);
    });
    await expect(planner.prepare(settings, token, abort.signal)).rejects.toThrow();
    expect(artifacts.dispose).toHaveBeenCalledOnce();
    prepareProvider.mockResolvedValueOnce({
      executable: 'TEST',
      env: {
        AGENT_TEAMS_LEAD_START_CREDENTIAL: 'TEST-never-propagate',
        CLAUDE_CODE_OAUTH_TOKEN: 'TEST-token',
      },
      args: [],
    });
    const plan = await planner.prepare(settings, token, new AbortController().signal);
    expect(plan.env.AGENT_TEAMS_LEAD_START_CREDENTIAL).toBeUndefined();
  });
});
