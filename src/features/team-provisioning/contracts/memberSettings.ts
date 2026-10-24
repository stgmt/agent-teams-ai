export type MemberSettingsProviderId = 'anthropic' | 'codex' | 'gemini' | 'opencode';
export type MemberSettingsProviderBackendId =
  | 'auto'
  | 'adapter'
  | 'api'
  | 'cli-sdk'
  | 'codex-native'
  | 'opencode-cli';
export type MemberSettingsEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type MemberSettingsFastMode = 'inherit' | 'on' | 'off';
export type MemberSettingsMcpScope = 'user' | 'project' | 'local';
export type MemberSettingsMcpMode = 'inheritLead' | 'inheritScopes' | 'strictAllowlist' | 'appOnly';

export interface MemberSettingsMcpPolicy {
  mode: MemberSettingsMcpMode;
  scopes?: Partial<Record<MemberSettingsMcpScope, boolean>>;
  serverNames?: string[];
}

/**
 * Complete editable settings for one existing team member.
 *
 * Every field is required. `null` explicitly clears an optional persisted
 * value; request producers must not use `undefined` as an implicit patch.
 */
export interface EditableMemberSettings {
  role: string | null;
  workflow: string | null;
  isolation: 'worktree' | null;
  providerId: MemberSettingsProviderId | null;
  providerBackendId: MemberSettingsProviderBackendId | null;
  model: string | null;
  effort: MemberSettingsEffort | null;
  fastMode: MemberSettingsFastMode | null;
  mcpPolicy: MemberSettingsMcpPolicy | null;
}

export type UpdateMemberSettingsEffect =
  | 'no_changes'
  | 'persisted_only'
  | 'member_restart_started'
  | 'member_restart_failed'
  | 'lead_restart_started'
  | 'lead_restart_rolled_back'
  | 'opencode_lane_restart_started'
  | 'team_relaunch_required'
  | 'recovery_required';

interface UpdateMemberSettingsRequestBase {
  commandId: string;
  idempotencyKey: string;
  teamName: string;
  memberName: string;
  expectedFingerprint: string;
}

export type UpdateMemberSettingsRequest = UpdateMemberSettingsRequestBase &
  (
    | { targetKind: 'member'; settings: EditableMemberSettings }
    | {
        targetKind: 'lead';
        leadRuntime: Pick<EditableMemberSettings, 'model' | 'effort'>;
      }
  );

/**
 * What is left of the teammate's process after a failed restart:
 * `running` (a process of the teammate is alive), `stopped` (none is alive), `unknown` (not determined).
 */
export type MemberRestartProcessState = 'running' | 'stopped' | 'unknown';

/** The settings are saved, the restart failed: the real cause and the state of the process. */
export interface MemberRestartFailure {
  cause: string;
  memberProcess: MemberRestartProcessState;
}

interface CompletedMemberSettingsResultBase {
  outcome: 'completed';
  memberName: string;
  previousFingerprint: string;
  currentFingerprint: string;
  replayed: boolean;
}

export type UpdateMemberSettingsResult =
  | (CompletedMemberSettingsResultBase & {
      effect: Exclude<UpdateMemberSettingsEffect, 'member_restart_failed'>;
      recovery?: {
        persistenceRestored: boolean;
        lifecycleRestored: boolean;
        cause: string;
      };
    })
  | (CompletedMemberSettingsResultBase & {
      effect: 'member_restart_failed';
      failure: MemberRestartFailure;
    })
  | {
      outcome: 'target_conflict';
      memberName: string;
      expectedFingerprint: string;
      actualFingerprint: string | null;
      reason: 'target_changed' | 'member_not_found' | 'team_not_found';
      replayed: boolean;
    }
  | {
      outcome: 'busy';
      teamName: string;
      memberName: string;
      replayed: boolean;
    };
