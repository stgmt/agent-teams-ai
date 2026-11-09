// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NodeTeamLaunchSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamLaunchSettings';

import type {
  PreparedTeamWorkspace,
  TeamWorkspacePort,
} from '../../../../src/features/team-provisioning/core/application/ports/TeamWorkspacePorts';
import type { TeamMember } from '../../../../src/shared/types';

const signal = (): AbortSignal => new AbortController().signal;

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

function documents() {
  return {
    meta: {
      version: 1 as const,
      runtimeSelectionVersion: 1 as const,
      cwd: process.cwd(),
      providerId: 'anthropic' as const,
      model: 'TEST-model',
      effort: 'high',
      skipPermissions: true,
      createdAt: 1,
    },
    members: [
      { name: 'builder', role: 'Builder', workflow: 'TEST-build' },
      { name: 'removed', removedAt: 1 },
    ] as TeamMember[],
  };
}

function setup(options: {
  specBindings?: readonly { project: string; spec: string }[];
  specRegistryEnvironment?: () => Promise<Readonly<Record<string, string>> | null>;
} = {}) {
  const saved = documents();
  const meta = options.specBindings
    ? { ...saved.meta, specBindings: [...options.specBindings] }
    : saved.meta;
  const settings = new NodeTeamLaunchSettings({
    teamsRoot: process.cwd(),
    metadata: {
      getMeta: () => Promise.resolve(meta),
    },
    members: {
      getMeta: () => Promise.resolve({ version: 1 as const, members: saved.members }),
    },
    ...(options.specRegistryEnvironment
      ? { specRegistryEnvironment: options.specRegistryEnvironment }
      : {}),
  });
  return { saved, settings };
}

describe('canonical configured team launch settings', () => {
  it('gives a spec-bound team the registry endpoint and token its spec MCP substitutes', async () => {
    const specRegistryEnvironment = vi.fn(async () => ({
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-token',
    }));
    const { settings } = setup({
      specBindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
      specRegistryEnvironment,
    });
    await settings.capture(run);
    const lead = await settings.findConfiguredMember(run, 'team-lead');
    expect(lead?.specRegistryEnv).toEqual({
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-token',
    });
    expect(specRegistryEnvironment).toHaveBeenCalledTimes(1);
  });

  it('carries the bound specifications and the registry recipe in the launch instructions', async () => {
    const { settings } = setup({
      specBindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
    });
    await settings.capture(run);
    const lead = await settings.findConfiguredMember(run, 'team-lead');
    expect(lead?.instructions).toContain('stgm/tokenplan / registry-check');
    expect(lead?.instructions).toContain('spec_patch');
    expect(lead?.instructions).toContain('requirements');
    const builder = await settings.findConfiguredMember(run, 'builder');
    expect(builder?.instructions).toContain('stgm/tokenplan / registry-check');
  });

  it('keeps instructions free of specification text when the team has no bindings', async () => {
    const { settings } = setup();
    await settings.capture(run);
    const builder = await settings.findConfiguredMember(run, 'builder');
    expect(builder?.instructions).not.toContain('spec_patch');
  });

  it('never hands registry credentials to a team without specification bindings', async () => {
    const specRegistryEnvironment = vi.fn(async () => ({
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8650/mcp',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-token',
    }));
    const { settings } = setup({ specRegistryEnvironment });
    await settings.capture(run);
    const builder = await settings.findConfiguredMember(run, 'builder');
    expect(builder?.specRegistryEnv).toBeUndefined();
    expect(specRegistryEnvironment).not.toHaveBeenCalled();
  });

  it('starts a bound team even when the registry credential cannot be resolved', async () => {
    const { settings } = setup({
      specBindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
      specRegistryEnvironment: async () => {
        throw new Error('MISSING_TOKEN');
      },
    });
    await settings.capture(run);
    const builder = await settings.findConfiguredMember(run, 'builder');
    expect(builder?.specRegistryEnv).toBeUndefined();
    expect(builder?.memberName).toBe('builder');
  });

  it('captures one revision of the configured roster, including the lead, and resolves inherited settings', async () => {
    const { settings } = setup();
    const team = await settings.capture(run);
    expect(team.members).toEqual([
      { memberName: 'team-lead', role: 'lead' },
      { memberName: 'builder', role: 'member' },
    ]);
    const builder = await settings.findConfiguredMember(run, 'builder');
    expect(builder).toMatchObject({
      memberName: 'builder',
      providerId: 'anthropic',
      model: 'TEST-model',
      effort: 'high',
      configurationRevision: team.configurationRevision,
      workingDirectory: process.cwd(),
    });
    expect(builder?.instructions).toContain('TEST-build');
    expect(await settings.findConfiguredMember(run, 'removed')).toBeNull();
    expect(await settings.findConfiguredMember(run, 'invented')).toBeNull();
  });

  it('carries configured CLI arguments rather than dropping them when resolving a member', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.meta, { extraCliArgs: '--max-turns 12' });
    await settings.capture(run);
    expect(await settings.findConfiguredMember(run, 'builder')).toMatchObject({
      extraCliArgs: '--max-turns 12',
    });
  });

  it('carries isolation and the team workspace separately from an explicit member working directory', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.members[0], { isolation: 'worktree', cwd: 'TEST-explicit-worktree' });
    await settings.capture(run);
    expect(await settings.findConfiguredMember(run, 'builder')).toMatchObject({
      isolation: 'worktree',
      baseWorkingDirectory: saved.meta.cwd,
      workingDirectory: 'TEST-explicit-worktree',
    });
  });

  it('requires named workspace preparation before resolving launches, then binds defaults and isolation to it without losing explicit cwd', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.meta, { worktree: 'TEST-team-worktree' });
    saved.members.push(
      { name: 'isolated', isolation: 'worktree' },
      { name: 'explicit', cwd: 'TEST-explicit' }
    );
    const captured = await settings.capture(run);
    await expect(settings.findConfiguredMember(run, 'builder')).rejects.toThrow(
      'workspace was not prepared'
    );
    await expect(settings.runtimeConfiguration(run)).rejects.toThrow('workspace was not prepared');
    const prepared = {
      workingDirectory: process.cwd() + '/TEST-resolved',
      worktree: { baseRepoPath: process.cwd(), branchName: 'TEST-team-branch' },
    };
    const prepareTeam = vi.fn<TeamWorkspacePort['prepareTeam']>(() => Promise.resolve(prepared));
    await settings.prepareWorkspace(run, { prepareTeam }, signal());
    expect(prepareTeam).toHaveBeenCalledWith(
      {
        teamName: run.teamName,
        workingDirectory: saved.meta.cwd,
        worktreeName: 'TEST-team-worktree',
      },
      expect.any(AbortSignal)
    );
    for (const name of ['team-lead', 'builder']) {
      expect(await settings.findConfiguredMember(run, name)).toMatchObject({
        workingDirectory: prepared.workingDirectory,
        baseWorkingDirectory: prepared.workingDirectory,
        worktree: prepared.worktree,
        configurationRevision: captured.configurationRevision,
      });
    }
    expect(await settings.findConfiguredMember(run, 'isolated')).toMatchObject({
      workingDirectory: prepared.workingDirectory,
      baseWorkingDirectory: prepared.workingDirectory,
      isolation: 'worktree',
    });
    const explicit = await settings.findConfiguredMember(run, 'explicit');
    expect(explicit).toMatchObject({
      workingDirectory: 'TEST-explicit',
      baseWorkingDirectory: prepared.workingDirectory,
    });
    expect(explicit?.worktree).toBeUndefined();
    prepared.workingDirectory = 'TEST-mutated-result';
    prepared.worktree.branchName = 'TEST-mutated-branch';
    expect((await settings.runtimeConfiguration(run)).members[0].launch.worktree?.branchName).toBe(
      'TEST-team-branch'
    );
    settings.release(run);
    await settings.capture({ ...run, runId: 'TEST-next' });
    await expect(
      settings.findConfiguredMember({ ...run, runId: 'TEST-next' }, 'builder')
    ).rejects.toThrow('workspace was not prepared');
  });

  it('re-admits a new member against a prepared worktree workspace', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.meta, { worktree: 'TEST-team-worktree' });
    await settings.capture(run);
    await settings.prepareWorkspace(
      run,
      {
        prepareTeam: async () => ({
          workingDirectory: process.cwd() + '/TEST-resolved',
          worktree: { baseRepoPath: process.cwd(), branchName: 'TEST-team-branch' },
        }),
      },
      signal()
    );
    saved.members.push({ name: 'tester', role: 'Tester' });
    await settings.admitConfiguredMember(run, 'tester');
    expect(await settings.findConfiguredMember(run, 'tester')).toMatchObject({
      memberName: 'tester',
      workingDirectory: process.cwd() + '/TEST-resolved',
      worktree: { branchName: 'TEST-team-branch' },
    });
    // The rebased capture must still own the prepared workspace on release.
    settings.release(run);
    await settings.capture({ ...run, runId: 'TEST-next' });
  });

  it('rejects admitting a member when an already-admitted member drifted', async () => {
    const { settings, saved } = setup();
    await settings.capture(run);
    saved.members.push({ name: 'tester' });
    Object.assign(saved.members[0], { model: 'TEST-other-model' });
    await expect(settings.admitConfiguredMember(run, 'tester')).rejects.toThrow(
      'changed after admission'
    );
  });

  it('does not resurrect a released capture when the reread finishes after release', async () => {
    const saved = documents();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let gated = false;
    const settings = new NodeTeamLaunchSettings({
      teamsRoot: process.cwd(),
      metadata: { getMeta: () => Promise.resolve(saved.meta) },
      members: {
        getMeta: async () => {
          if (gated) {
            gated = false;
            await readGate;
          }
          return { version: 1 as const, members: saved.members };
        },
      },
    });
    await settings.capture(run);
    gated = true;
    saved.members.push({ name: 'tester' });
    const admission = settings.admitConfiguredMember(run, 'tester');
    settings.release(run);
    releaseRead();
    await expect(admission).rejects.toThrow('were not captured');
    await settings.capture({ ...run, runId: 'TEST-next' });
    expect(await settings.findConfiguredMember({ ...run, runId: 'TEST-next' }, 'builder')).not.toBe(
      null
    );
  });

  it('drains workspace allocation after cancellation without retaining its late result or touching a successor capture', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.meta, { worktree: 'TEST-team-worktree' });
    const abort = new AbortController();
    await settings.capture(run, abort.signal);
    let finish!: (value: Readonly<PreparedTeamWorkspace>) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const prepareTeam: TeamWorkspacePort['prepareTeam'] = () =>
      new Promise((resolve) => {
        finish = resolve;
        entered();
      });
    const pending = settings.prepareWorkspace(run, { prepareTeam }, abort.signal);
    let settled = false;
    const rejected = expect(pending).rejects.toThrow('TEST cancelled workspace');
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await started;
    abort.abort(new Error('TEST cancelled workspace'));
    const next = { ...run, runId: 'TEST-next' };
    await settings.capture(next);
    expect(settled).toBe(false);
    finish({ workingDirectory: process.cwd() });
    await rejected;
    await expect(settings.findConfiguredMember(next, 'builder')).rejects.toThrow(
      'workspace was not prepared'
    );
  });

  it('rejects canonical changes made while a named workspace is being prepared', async () => {
    const { settings, saved } = setup();
    Object.assign(saved.meta, { worktree: 'TEST-team-worktree' });
    await settings.capture(run);
    await expect(
      settings.prepareWorkspace(
        run,
        {
          prepareTeam: () => {
            saved.meta.cwd = 'TEST-changed-root';
            return Promise.resolve({ workingDirectory: process.cwd() });
          },
        },
        signal()
      )
    ).rejects.toThrow('changed');
    await expect(settings.findConfiguredMember(run, 'builder')).rejects.toThrow('changed');
  });

  it('rejects changed canonical settings and roster rather than silently launching another revision', async () => {
    const { settings, saved } = setup();
    await settings.capture(run);
    saved.meta.model = 'TEST-new-model';
    await expect(settings.findConfiguredMember(run, 'builder')).rejects.toThrow('changed');
  });

  it('does not invalidate launch authority for presentation or process diagnostic changes', async () => {
    const { settings, saved } = setup();
    const captured = await settings.capture(run);
    Object.assign(saved.meta, { displayName: 'Renamed team' });
    Object.assign(saved.members[0], { color: 'blue', joinedAt: 500, agentId: 'runtime-only-id' });
    expect((await settings.findConfiguredMember(run, 'builder'))?.configurationRevision).toBe(
      captured.configurationRevision
    );
    expect(await settings.findConfiguredMember(run, 'team-lead')).toMatchObject({
      role: 'lead',
      model: 'TEST-model',
    });
  });

  it('keeps the same launch revision when nested MCP policy keys are reordered without changing policy', async () => {
    const { settings, saved } = setup();
    saved.members[0].mcpPolicy = {
      mode: 'strictAllowlist',
      serverNames: ['TEST-server'],
      scopes: { project: true, user: false },
    };
    const captured = await settings.capture(run);
    saved.members[0].mcpPolicy = {
      scopes: { user: false, project: true },
      serverNames: ['TEST-server'],
      mode: 'strictAllowlist',
    };
    expect((await settings.findConfiguredMember(run, 'builder'))?.configurationRevision).toBe(
      captured.configurationRevision
    );
    saved.members[0].mcpPolicy.scopes!.user = true;
    await expect(settings.findConfiguredMember(run, 'builder')).rejects.toThrow('changed');
  });

  it('does not borrow settings from a foreign or stale run', async () => {
    const { settings } = setup();
    await settings.capture(run);
    await expect(
      settings.findConfiguredMember({ ...run, runId: 'other' }, 'builder')
    ).rejects.toThrow('captured');
    await expect(
      settings.findConfiguredMember({ ...run, appInstanceId: 'foreign' }, 'builder')
    ).rejects.toThrow('captured');
  });

  it('does not let a rejected or foreign capture replace the current run settings', async () => {
    const { settings } = setup();
    const captured = await settings.capture(run);
    await expect(settings.capture({ ...run, runId: 'other' })).rejects.toThrow('captured');
    expect((await settings.findConfiguredMember(run, 'builder'))?.configurationRevision).toBe(
      captured.configurationRevision
    );
  });

  it('does not capture settings when a cancelled read returns after a replacement run was captured', async () => {
    const saved = documents();
    let resolve!: (value: typeof saved.meta) => void;
    const pending = new Promise<typeof saved.meta>((complete) => {
      resolve = complete;
    });
    const metadata = {
      getMeta: vi.fn(() => Promise.resolve(saved.meta)).mockImplementationOnce(() => pending),
    };
    const settings = new NodeTeamLaunchSettings({
      teamsRoot: process.cwd(),
      metadata,
      members: {
        getMeta: () => Promise.resolve({ version: 1 as const, members: saved.members }),
      },
    });
    const abort = new AbortController();
    const first = settings.capture(run, abort.signal);
    const rejected = expect(first).rejects.toThrow();
    abort.abort();
    await rejected;
    const next = { ...run, runId: 'TEST-next-run' };
    await settings.capture(next);
    resolve(saved.meta);
    await pending;
    expect((await settings.findConfiguredMember(next, 'builder'))?.memberName).toBe('builder');
  });

  it('discards a completed capture if its pending launch is then cancelled', async () => {
    const { settings } = setup();
    const abort = new AbortController();
    await settings.capture(run, abort.signal);
    abort.abort();
    const next = { ...run, runId: 'TEST-next' };
    await expect(settings.capture(next)).resolves.toMatchObject({ members: expect.any(Array) });
  });

  it('requires complete canonical documents and does not turn missing member metadata into an empty roster', async () => {
    const saved = documents();
    const metadata = { getMeta: vi.fn(() => Promise.resolve(saved.meta)) };
    const members = { getMeta: vi.fn(() => Promise.resolve(null)) };
    const settings = new NodeTeamLaunchSettings({ teamsRoot: process.cwd(), metadata, members });
    await expect(settings.capture(run)).rejects.toThrow('member metadata');
    expect(metadata.getMeta).toHaveBeenCalledWith(run.teamName, process.cwd(), {
      requireCompleteFields: true,
    });
    expect(members.getMeta).toHaveBeenCalledWith(run.teamName, {
      requireCompleteMembers: true,
      teamsBasePath: process.cwd(),
    });
  });

  it('detaches and freezes nested MCP policy from the saved document', async () => {
    const { settings, saved } = setup();
    saved.members[0].mcpPolicy = {
      mode: 'strictAllowlist',
      serverNames: ['TEST-server'],
      scopes: { project: true },
    };
    await settings.capture(run);
    const launch = await settings.findConfiguredMember(run, 'builder');
    expect(launch?.mcpPolicy).not.toBe(saved.members[0].mcpPolicy);
    expect(Object.isFrozen(launch?.mcpPolicy)).toBe(true);
    expect(Object.isFrozen(launch?.mcpPolicy?.scopes)).toBe(true);
    expect(Object.isFrozen(launch?.mcpPolicy?.serverNames)).toBe(true);
    saved.members[0].mcpPolicy.serverNames!.push('TEST-added');
    expect(launch?.mcpPolicy?.serverNames).toEqual(['TEST-server']);
  });

  it('reads only the canonical metadata and refuses absent metadata or multiple leads', async () => {
    const { saved } = setup();
    const missing = new NodeTeamLaunchSettings({
      teamsRoot: process.cwd(),
      metadata: {
        getMeta: () => Promise.resolve(null),
      },
      members: {
        getMeta: () => Promise.resolve({ version: 1 as const, members: saved.members }),
      },
    });
    await expect(missing.capture(run)).rejects.toThrow('metadata');
    saved.members.push({ name: 'another-lead', agentType: 'team-lead' });
    saved.members.push({ name: 'second-lead', agentType: 'team-lead' });
    const invalid = new NodeTeamLaunchSettings({
      teamsRoot: process.cwd(),
      metadata: {
        getMeta: () => Promise.resolve(saved.meta),
      },
      members: {
        getMeta: () => Promise.resolve({ version: 1 as const, members: saved.members }),
      },
    });
    await expect(invalid.capture(run)).rejects.toThrow('exactly one lead');
  });
});
