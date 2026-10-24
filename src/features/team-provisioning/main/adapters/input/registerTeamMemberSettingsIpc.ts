import { validateMemberName, validateTeamName } from '@main/ipc/guards';
import { isReservedLeadRole } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';

import { TEAM_UPDATE_MEMBER_SETTINGS } from '../../../contracts';

import type {
  EditableMemberSettings,
  MemberSettingsMcpPolicy,
  UpdateMemberSettingsRequest,
  UpdateMemberSettingsResult,
} from '../../../contracts/memberSettings';
import type { TeamMemberSettingsFeatureApi } from '../../composition/createTeamMemberSettingsFeature';
import type { IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('Feature:team-provisioning:memberSettingsIpc');

const SETTINGS_KEYS = [
  'role',
  'workflow',
  'isolation',
  'providerId',
  'providerBackendId',
  'model',
  'effort',
  'fastMode',
  'mcpPolicy',
] as const;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_TEXT_LENGTH = 16_384;
const MAX_FINGERPRINT_LENGTH = 65_536;
const MAX_MCP_SERVERS = 100;
const MAX_MCP_SERVER_NAME_LENGTH = 128;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  if (normalized.length > maxLength) throw new TypeError(`${field} is too long`);
  return normalized;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field, MAX_TEXT_LENGTH);
}

function validatedIdentifier(
  value: unknown,
  field: 'teamName' | 'memberName',
  validate: typeof validateTeamName | typeof validateMemberName
): string {
  const raw = requiredString(value, field, MAX_NAME_LENGTH);
  const result = validate(raw);
  if (!result.valid || !result.value) {
    throw new TypeError(result.error ?? `${field} is invalid`);
  }
  return result.value;
}

function nullableUnion<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${field} has an unsupported value`);
  }
  return value as T;
}

function parseMcpPolicy(value: unknown): MemberSettingsMcpPolicy | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new TypeError('settings.mcpPolicy must be an object or null');
  const unknownPolicyKey = Object.keys(value).find(
    (key) => key !== 'mode' && key !== 'scopes' && key !== 'serverNames'
  );
  if (unknownPolicyKey) throw new TypeError(`Unsupported MCP policy field: ${unknownPolicyKey}`);
  const mode = nullableUnion(value.mode, 'settings.mcpPolicy.mode', [
    'inheritLead',
    'inheritScopes',
    'strictAllowlist',
    'appOnly',
  ] as const);
  if (!mode) throw new TypeError('settings.mcpPolicy.mode is required');

  let scopes: MemberSettingsMcpPolicy['scopes'];
  if (value.scopes !== undefined) {
    if (!isPlainObject(value.scopes)) {
      throw new TypeError('settings.mcpPolicy.scopes must be an object');
    }
    const unknownScope = Object.keys(value.scopes).find(
      (key) => key !== 'user' && key !== 'project' && key !== 'local'
    );
    if (unknownScope) throw new TypeError(`Unsupported MCP scope: ${unknownScope}`);
    for (const [key, enabled] of Object.entries(value.scopes)) {
      if (typeof enabled !== 'boolean') {
        throw new TypeError(`settings.mcpPolicy.scopes.${key} must be boolean`);
      }
    }
    scopes = { ...value.scopes };
  }

  let serverNames: string[] | undefined;
  if (value.serverNames !== undefined) {
    if (!Array.isArray(value.serverNames) || value.serverNames.length > MAX_MCP_SERVERS) {
      throw new TypeError('settings.mcpPolicy.serverNames must be a bounded array');
    }
    const seen = new Set<string>();
    serverNames = value.serverNames
      .map((name, index) =>
        requiredString(name, `settings.mcpPolicy.serverNames[${index}]`, MAX_MCP_SERVER_NAME_LENGTH)
      )
      .filter((name) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort();
  }
  return { mode, ...(scopes ? { scopes } : {}), ...(serverNames ? { serverNames } : {}) };
}

function parseSettings(value: unknown): EditableMemberSettings {
  if (!isPlainObject(value)) throw new TypeError('settings must be an object');
  for (const key of SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`settings.${key} is required; use null to clear it`);
    }
  }
  const unknownKey = Object.keys(value).find(
    (key) => !SETTINGS_KEYS.includes(key as (typeof SETTINGS_KEYS)[number])
  );
  if (unknownKey) throw new TypeError(`Unsupported settings field: ${unknownKey}`);

  const role = nullableText(value.role, 'settings.role');
  if (role && isReservedLeadRole(role)) {
    throw new TypeError('settings.role is reserved for the team lead');
  }

  return {
    role,
    workflow: nullableText(value.workflow, 'settings.workflow'),
    isolation: nullableUnion(value.isolation, 'settings.isolation', ['worktree'] as const),
    providerId: nullableUnion(value.providerId, 'settings.providerId', [
      'anthropic',
      'codex',
      'gemini',
      'opencode',
    ] as const),
    providerBackendId: nullableUnion(value.providerBackendId, 'settings.providerBackendId', [
      'auto',
      'adapter',
      'api',
      'cli-sdk',
      'codex-native',
      'opencode-cli',
    ] as const),
    model: nullableText(value.model, 'settings.model'),
    effort: nullableUnion(value.effort, 'settings.effort', [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ] as const),
    fastMode: nullableUnion(value.fastMode, 'settings.fastMode', ['inherit', 'on', 'off'] as const),
    mcpPolicy: parseMcpPolicy(value.mcpPolicy),
  };
}

export function parseUpdateMemberSettingsRequest(value: unknown): UpdateMemberSettingsRequest {
  if (!isPlainObject(value)) throw new TypeError('request must be a plain object');
  const base = {
    commandId: requiredString(value.commandId, 'commandId', MAX_ID_LENGTH),
    idempotencyKey: requiredString(value.idempotencyKey, 'idempotencyKey', MAX_ID_LENGTH),
    teamName: validatedIdentifier(value.teamName, 'teamName', validateTeamName),
    memberName: validatedIdentifier(value.memberName, 'memberName', validateMemberName),
    expectedFingerprint: requiredString(
      value.expectedFingerprint,
      'expectedFingerprint',
      MAX_FINGERPRINT_LENGTH
    ),
  };
  const targetKind = requiredString(value.targetKind, 'targetKind', 16);
  if (targetKind === 'lead') {
    if (!isPlainObject(value.leadRuntime)) {
      throw new TypeError('leadRuntime must be an object');
    }
    const unknownKey = Object.keys(value.leadRuntime).find(
      (key) => key !== 'model' && key !== 'effort'
    );
    if (unknownKey) throw new TypeError(`Unsupported lead runtime field: ${unknownKey}`);
    return {
      ...base,
      targetKind,
      leadRuntime: {
        model: nullableText(value.leadRuntime.model, 'leadRuntime.model'),
        effort: nullableUnion(value.leadRuntime.effort, 'leadRuntime.effort', [
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
          'ultra',
        ] as const),
      },
    };
  }
  if (targetKind !== 'member') throw new TypeError('targetKind must be member or lead');
  return { ...base, targetKind, settings: parseSettings(value.settings) };
}

/** Join key for the log lines of one command; reads untrusted input without validating it. */
function describeRequest(value: unknown): string {
  const read = (key: string): string => {
    const raw = isPlainObject(value) ? value[key] : undefined;
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_NAME_LENGTH) : '?';
  };
  return `team=${read('teamName')} member=${read('memberName')} command=${read('commandId')} target=${read('targetKind')}`;
}

function logResult(context: string, result: UpdateMemberSettingsResult): void {
  if (result.outcome !== 'completed') {
    logger.diagnostic(`Member settings update finished: ${context} outcome=${result.outcome}`);
    return;
  }
  const summary = `Member settings update finished: ${context} outcome=completed effect=${result.effect} replayed=${result.replayed === true}`;
  if (result.effect === 'member_restart_failed') {
    logger.warn(
      `${summary} memberProcess=${result.failure.memberProcess} cause=${result.failure.cause}`
    );
  } else if (
    result.effect === 'recovery_required' ||
    result.effect === 'lead_restart_rolled_back'
  ) {
    logger.warn(`${summary} cause=${result.recovery?.cause ?? 'unknown'}`);
  } else {
    logger.diagnostic(summary);
  }
}

export function registerTeamMemberSettingsIpc(
  ipcMain: IpcMain,
  feature: TeamMemberSettingsFeatureApi
): void {
  ipcMain.handle(
    TEAM_UPDATE_MEMBER_SETTINGS,
    async (
      _event: IpcMainInvokeEvent,
      value: unknown
    ): Promise<IpcResult<UpdateMemberSettingsResult>> => {
      const context = describeRequest(value);
      try {
        const request = parseUpdateMemberSettingsRequest(value);
        logger.diagnostic(`Member settings update accepted: ${context}`);
        const data = await feature.updateMemberSettings(request);
        logResult(context, data);
        return { success: true, data };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `Member settings update failed: ${context}: ${error instanceof Error ? (error.stack ?? message) : message}`
        );
        return { success: false, error: message };
      }
    }
  );
}

export function removeTeamMemberSettingsIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_UPDATE_MEMBER_SETTINGS);
}
