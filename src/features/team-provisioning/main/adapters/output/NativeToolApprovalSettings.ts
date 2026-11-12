import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/toolApproval';

import type { ToolApprovalSettings } from '@shared/types';

/**
 * In-memory tool approval settings, matching the legacy facade's lifetime.
 * A launch with manual permissions resets to defaults; skipping permissions
 * auto-allows everything for that team.
 */
export class NativeToolApprovalSettings {
  private readonly byTeam = new Map<string, ToolApprovalSettings>();

  get(teamName: string): ToolApprovalSettings {
    return this.byTeam.get(teamName) ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
  }

  update(teamName: string, settings: ToolApprovalSettings): void {
    this.byTeam.set(teamName, Object.freeze({ ...settings }));
  }

  initializeForLaunch(teamName: string, skipPermissions: boolean | undefined): void {
    this.update(
      teamName,
      skipPermissions === false
        ? DEFAULT_TOOL_APPROVAL_SETTINGS
        : { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true }
    );
  }

  clear(teamName: string): void {
    this.byTeam.delete(teamName);
  }
}
