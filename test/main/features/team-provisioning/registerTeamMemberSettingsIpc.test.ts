import { TEAM_UPDATE_MEMBER_SETTINGS } from '@features/team-provisioning/contracts';
import {
  registerTeamMemberSettingsIpc,
  removeTeamMemberSettingsIpc,
} from '@features/team-provisioning/main/adapters/input/registerTeamMemberSettingsIpc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamMemberSettingsFeatureApi } from '@features/team-provisioning/main/composition/createTeamMemberSettingsFeature';
import type { IpcMain } from 'electron';

const logLines = vi.hoisted(() => ({
  diagnostics: [] as string[],
  warnings: [] as string[],
  errors: [] as string[],
}));

vi.mock('@shared/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: () => undefined,
      info: () => undefined,
      diagnostic: (message: string) => logLines.diagnostics.push(message),
      warn: (message: string) => logLines.warnings.push(message),
      error: (message: string) => logLines.errors.push(message),
    }),
  };
});

beforeEach(() => {
  logLines.diagnostics.length = 0;
  logLines.warnings.length = 0;
  logLines.errors.length = 0;
});

function request() {
  return {
    commandId: ' command-1 ',
    idempotencyKey: ' idem-1 ',
    teamName: ' team-a ',
    memberName: ' Alice ',
    expectedFingerprint: ' fingerprint ',
    targetKind: 'member',
    settings: {
      role: ' builder ',
      workflow: null,
      isolation: 'worktree',
      providerId: 'codex',
      providerBackendId: 'cli-sdk',
      model: ' model ',
      effort: 'high',
      fastMode: 'on',
      mcpPolicy: {
        mode: 'strictAllowlist',
        scopes: { user: true, project: false },
        serverNames: [' beta ', 'alpha', 'alpha'],
      },
    },
  };
}

function registerHandler(feature: TeamMemberSettingsFeatureApi) {
  let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
  const ipcMain = {
    handle: vi.fn((_channel, next) => {
      handler = next;
    }),
    removeHandler: vi.fn(),
  } as unknown as IpcMain;
  registerTeamMemberSettingsIpc(ipcMain, feature);
  return (value: unknown) => handler!({}, value);
}

describe('registerTeamMemberSettingsIpc', () => {
  it('validates and normalizes untrusted input into a standard success result', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn(async (value) => ({
      outcome: 'completed' as const,
      effect: 'persisted_only' as const,
      memberName: value.memberName,
      previousFingerprint: value.expectedFingerprint,
      currentFingerprint: 'next',
      replayed: false,
    }));
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    const result = await handler?.({}, request());

    expect(ipcMain.handle).toHaveBeenCalledWith(TEAM_UPDATE_MEMBER_SETTINGS, expect.any(Function));
    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'command-1',
        teamName: 'team-a',
        memberName: 'Alice',
        settings: expect.objectContaining({
          role: 'builder',
          model: 'model',
          mcpPolicy: expect.objectContaining({ serverNames: ['alpha', 'beta'] }),
        }),
      })
    );
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ outcome: 'completed' }),
    });
  });

  it.each([
    ['teamName', '../outside'],
    ['memberName', '../outside'],
  ] as const)('rejects path traversal in %s before calling the feature', async (field, value) => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn();
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    const result = await handler?.({}, { ...request(), [field]: value });

    expect(result).toMatchObject({ success: false });
    expect(updateMemberSettings).not.toHaveBeenCalled();
  });

  it.each(['lead', 'team lead', 'team-lead', 'orchestrator'])(
    'rejects the reserved role %s before calling the feature',
    async (role) => {
      let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
      const ipcMain = {
        handle: vi.fn((_channel, next) => {
          handler = next;
        }),
        removeHandler: vi.fn(),
      } as unknown as IpcMain;
      const updateMemberSettings = vi.fn();
      registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

      const value = request();
      value.settings.role = ` ${role.toUpperCase()} `;
      const result = await handler?.({}, value);

      expect(result).toEqual({
        success: false,
        error: 'settings.role is reserved for the team lead',
      });
      expect(updateMemberSettings).not.toHaveBeenCalled();
    }
  );

  it('accepts only model and effort for explicit lead intent', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const updateMemberSettings = vi.fn(async () => ({
      outcome: 'completed' as const,
      effect: 'lead_restart_started' as const,
      memberName: 'Lead',
      previousFingerprint: 'before',
      currentFingerprint: 'after',
      replayed: false,
    }));
    registerTeamMemberSettingsIpc(ipcMain, { updateMemberSettings });

    await expect(
      handler?.(
        {},
        {
          ...request(),
          targetKind: 'lead',
          settings: undefined,
          leadRuntime: { model: 'claude-opus-4-1', effort: 'high' },
        }
      )
    ).resolves.toMatchObject({ success: true });
    expect(updateMemberSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: 'lead',
        leadRuntime: { model: 'claude-opus-4-1', effort: 'high' },
      })
    );

    await expect(
      handler?.(
        {},
        {
          ...request(),
          targetKind: 'lead',
          settings: undefined,
          leadRuntime: { model: 'claude-opus-4-1', effort: 'high', role: 'lead' },
        }
      )
    ).resolves.toMatchObject({ success: false });
  });

  it('rejects partial settings and removes the registered handler', async () => {
    let handler: ((event: unknown, value: unknown) => Promise<unknown>) | undefined;
    const ipcMain = {
      handle: vi.fn((_channel, next) => {
        handler = next;
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const feature: TeamMemberSettingsFeatureApi = { updateMemberSettings: vi.fn() };
    registerTeamMemberSettingsIpc(ipcMain, feature);
    const invalid = request();
    delete (invalid.settings as Partial<typeof invalid.settings>).workflow;

    await expect(handler?.({}, invalid)).resolves.toEqual({
      success: false,
      error: 'settings.workflow is required; use null to clear it',
    });
    expect(feature.updateMemberSettings).not.toHaveBeenCalled();

    removeTeamMemberSettingsIpc(ipcMain);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(TEAM_UPDATE_MEMBER_SETTINGS);
  });

  describe('journal of the command (SR-16)', () => {
    it('writes the full text of a feature failure before returning the standard error', async () => {
      const failure = new Error('Process 62728 remained alive after cleanup');
      const call = registerHandler({ updateMemberSettings: vi.fn().mockRejectedValue(failure) });

      const result = await call(request());

      expect(result).toEqual({
        success: false,
        error: 'Process 62728 remained alive after cleanup',
      });
      expect(logLines.errors).toHaveLength(1);
      expect(logLines.errors[0]).toContain(
        'Member settings update failed: team=team-a member=Alice command=command-1 target=member'
      );
      expect(logLines.errors[0]).toContain('Process 62728 remained alive after cleanup');
      expect(logLines.errors[0]).toContain(failure.stack?.split('\n')[1]?.trim());
    });

    it('writes a rejected request with the readable join key', async () => {
      const call = registerHandler({ updateMemberSettings: vi.fn() });
      const invalid = request();
      invalid.settings.role = ' LEAD ';

      await call(invalid);

      expect(logLines.errors).toHaveLength(1);
      expect(logLines.errors[0]).toContain('team=team-a member=Alice command=command-1');
      expect(logLines.errors[0]).toContain('settings.role is reserved for the team lead');
      expect(logLines.diagnostics).toEqual([]);
    });

    it('does not break on input that is not an object', async () => {
      const call = registerHandler({ updateMemberSettings: vi.fn() });

      await expect(call(null)).resolves.toMatchObject({ success: false });

      expect(logLines.errors[0]).toContain('team=? member=? command=? target=?');
    });

    it('writes the accepted command and the finished outcome', async () => {
      const call = registerHandler({
        updateMemberSettings: vi.fn(async () => ({
          outcome: 'completed' as const,
          effect: 'member_restart_started' as const,
          memberName: 'Alice',
          previousFingerprint: 'a',
          currentFingerprint: 'b',
          replayed: true,
        })),
      });

      await call(request());

      expect(logLines.diagnostics).toEqual([
        'Member settings update accepted: team=team-a member=Alice command=command-1 target=member',
        'Member settings update finished: team=team-a member=Alice command=command-1 target=member outcome=completed effect=member_restart_started replayed=true',
      ]);
      expect(logLines.warnings).toEqual([]);
      expect(logLines.errors).toEqual([]);
    });

    it('warns with the cause and the process state when the restart failed after saving', async () => {
      const call = registerHandler({
        updateMemberSettings: vi.fn(async () => ({
          outcome: 'completed' as const,
          effect: 'member_restart_failed' as const,
          memberName: 'Alice',
          previousFingerprint: 'a',
          currentFingerprint: 'b',
          replayed: false,
          failure: { cause: 'spawn failed: ENOENT', memberProcess: 'stopped' as const },
        })),
      });

      await call(request());

      expect(logLines.warnings).toEqual([
        'Member settings update finished: team=team-a member=Alice command=command-1 target=member outcome=completed effect=member_restart_failed replayed=false memberProcess=stopped cause=spawn failed: ENOENT',
      ]);
    });

    it('warns with the recovery cause for recovery_required and a rolled-back lead restart', async () => {
      for (const effect of ['recovery_required', 'lead_restart_rolled_back'] as const) {
        logLines.warnings.length = 0;
        const call = registerHandler({
          updateMemberSettings: vi.fn(async () => ({
            outcome: 'completed' as const,
            effect,
            memberName: 'Alice',
            previousFingerprint: 'a',
            currentFingerprint: 'a',
            replayed: false,
            recovery: {
              persistenceRestored: true,
              lifecycleRestored: false,
              cause: 'disk is read-only',
            },
          })),
        });

        await call(request());

        expect(logLines.warnings).toEqual([
          `Member settings update finished: team=team-a member=Alice command=command-1 target=member outcome=completed effect=${effect} replayed=false cause=disk is read-only`,
        ]);
      }
    });

    it('writes busy and conflict outcomes as diagnostics, not as warnings', async () => {
      const call = registerHandler({
        updateMemberSettings: vi.fn(async () => ({
          outcome: 'busy' as const,
          teamName: 'team-a',
          memberName: 'Alice',
          replayed: false,
        })),
      });

      await call(request());

      expect(logLines.diagnostics).toContain(
        'Member settings update finished: team=team-a member=Alice command=command-1 target=member outcome=busy'
      );
      expect(logLines.warnings).toEqual([]);
    });
  });
});
