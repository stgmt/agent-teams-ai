import { fingerprintSavedLaunchSettings } from '@features/team-provisioning/contracts';
import { fromProvisioningMembers, isMixedOpenCodeSideLanePlan } from '@features/team-runtime-lanes';
import { yieldToEventLoop } from '@main/utils/asyncYield';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { stripAgentBlocks, wrapAgentBlock } from '@shared/constants/agentBlocks';
import { getMemberColorByName } from '@shared/constants/memberColors';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import {
  isCanonicalSettingsLeadMember,
  isConversationLeadAlias,
  isLeadMember,
  resolveRuntimeLeadName,
} from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { buildStandaloneSlashCommandMeta } from '@shared/utils/slashCommands';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
  parseNumericSuffixName,
  validateTeamMemberNameFormat,
} from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { resolveTeamRuntimeSelection } from '@shared/utils/teamRuntimeSelection';
import { extractToolPreview, formatToolSummaryFromCalls } from '@shared/utils/toolSummary';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getAppDataPath } from '../../utils/pathDecoder';
import { verifyLocalTaskArtifact } from '../identity/VerifiedLocalTaskArtifact';
import { gitIdentityResolver } from '../parsing/GitIdentityResolver';

import {
  areLeadSessionFileSignaturesEqual,
  type LeadSessionFileSignature,
  LeadSessionParseCache,
  type LeadSessionParseCacheKey,
} from './cache/LeadSessionParseCache';
import { ExecutionTaskStore, validateExecutionTaskPatch } from './execution/ExecutionTaskStore';
import { TaskAttestationJournal } from './execution/TaskAttestationJournal';
import {
  type RegistryBoardSnapshotReadOptions,
  type RegistryBoardSnapshotReadPort,
  RegistryTaskProvider,
  RegistryTaskProviderError,
  type RegistryTaskScope,
} from './registry/RegistryTaskProvider';
import { RegistryTeamTaskWriteError } from './registry/RegistryTeamTaskWriter';
import { discoverSpecRegistry } from './registry/SpecRegistryDiscovery';
import {
  resolveTeamSpecBindings,
  resolveTeamSpecScope,
  type TeamSpecBinding,
  TeamSpecBindingError,
  type TeamSpecScope,
  validateSpecBinding,
} from './registry/TeamSpecBinding';
import { atomicWriteAsync } from './atomicWrite';
import { readConsistentTaskSnapshot } from './consistentTaskSnapshot';
import { createDraftTeamConfig } from './createDraftTeamConfig';
import { assertDraftRenameDestinationAvailable, renameDraftTeamDirectory } from './draftTeamRename';
import { extractLeadSessionMessagesFromJsonl } from './leadSessionMessageExtractor';
import { MemberActivityMetaService } from './MemberActivityMetaService';
import {
  permanentlyDeleteTeamData,
  type PermanentTeamDataDeletionOptions,
} from './permanentTeamDataDeletion';
import { resolveSyntheticLeadRuntimeSettings } from './syntheticLeadRuntimeSettings';
import {
  assertTaskGroupChatAssociation,
  type TaskGroupChatCatalog,
} from './taskGroupChatAssociation';
import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { resolveProjectPathFromConfig, TeamConfigReader } from './TeamConfigReader';
import { setTeamDeleted, updateTeamConfiguration } from './TeamConfigurationMutations';
import {
  type RegistryTaskWriteTarget,
  TeamDataRegistryTaskOperations,
  type TeamRegistryTaskWriterProvider,
} from './TeamDataRegistryTaskOperations';
import { TeamDataTaskEvents } from './TeamDataTaskEvents';
import { TeamDataTaskSnapshotProjection } from './TeamDataTaskSnapshotProjection';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamKanbanManager } from './TeamKanbanManager';
import { hasMixedPersistedLaunchMetadata } from './TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { isMaterializableInboxMemberName, TeamMemberResolver } from './TeamMemberResolver';
import { planTeamMemberRestore } from './TeamMemberRestorePlan';
import { TeamMemberRuntimeAdvisoryService } from './TeamMemberRuntimeAdvisoryService';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMessageFeedService } from './TeamMessageFeedService';
import { readTeamMessagesPage } from './TeamMessagePageRead';
import { TeamMetaStore } from './TeamMetaStore';
import { assertProvisioningTeamName } from './TeamRequestValidation';
import { applyDistinctRosterColors } from './teamRosterColors';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { selectCurrentActiveTeamTask } from './teamTaskActiveState';
import { TeamTaskAttachmentStore } from './TeamTaskAttachmentStore';
import { TeamTaskCommentNotificationJournal } from './TeamTaskCommentNotificationJournal';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type { DesktopSigningKeyStore } from '../identity/DesktopSigningKeyStore';
import type { TaskChangePresenceRepository } from './cache/TaskChangePresenceRepository';
import type { ExecutionTaskPatch } from './execution/ExecutionTaskStore';
import type { RegistryTaskTransition } from './registry/RegistryTaskClientTypes';
import type { TaskCommentNotificationJournalStore } from './TaskCommentNotificationJournalStore';
import type { TeamFileWritePolicy } from './teamFileWritePolicy';
import type { TeamLogSourceTracker } from './TeamLogSourceTracker';
import type { TeamMetaFile } from './TeamMetaStore';
import type { TeamAgentRuntimeSnapshot } from '@shared/types';
import type { AgentActionMode } from '@shared/types';
import type {
  AddMemberRequest,
  AttachmentMeta,
  CreateTaskRequest,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  KanbanState,
  MessagesPage,
  PersistedTeamLaunchSnapshot,
  ReplaceMembersRequest,
  SendMessageRequest,
  SendMessageResult,
  TaskArtifactProof,
  TaskAttachmentMeta,
  TaskChangePresenceState,
  TaskComment,
  TaskFieldUpdates,
  TaskRef,
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamGetDataOptions,
  TeamMember,
  TeamMemberActivityMeta,
  TeamMemberSnapshot,
  TeamProcess,
  TeamProviderId,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamTaskWithKanban,
  TeamViewSnapshot,
  ToolCallMeta,
  UpdateKanbanPatch,
} from '@shared/types';
import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';
import type { AgentTeamsController } from 'agent-teams-controller';

const { createController } = agentTeamsControllerModule;

const logger = createLogger('Service:TeamDataService');

type UnknownKanbanOutcomeCode = 'KANBAN_TRANSITION_UNCERTAIN' | 'KANBAN_SNAPSHOT_CHANGED';

/**
 * The controller's kanban guard always throws a real Error carrying one of these codes;
 * rethrowing the same object keeps its identity and `code` for callers to match on.
 */
function isUnknownKanbanOutcomeError(
  error: unknown
): error is Error & { code: UnknownKanbanOutcomeCode } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'KANBAN_TRANSITION_UNCERTAIN' || error.code === 'KANBAN_SNAPSHOT_CHANGED')
  );
}

function throwIfKanbanOutcomeUnknown(error: unknown): void {
  if (isUnknownKanbanOutcomeError(error)) throw error;
}

const MIN_TEXT_LENGTH = 30;
const MAX_LEAD_TEXTS = 150;
const LEAD_SESSION_PARSE_CACHE_SCHEMA_VERSION = 'combined-v2';
const PROCESS_HEALTH_INTERVAL_MS = 2_000;
const TASK_MAP_YIELD_EVERY = 250;
const TASK_COMMENT_NOTIFICATION_SOURCE = 'system_notification';
const MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS = 250;
const GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY = 12;

const TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS = 5_000;
const SAFE_DIAGNOSTIC_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MIXED_TEAM_LIVE_MUTATION_BLOCK_MESSAGE =
  'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.';

function toSafeDiagnosticIdentifier(value: string): string {
  return SAFE_DIAGNOSTIC_IDENTIFIER_PATTERN.test(value) ? value : 'redacted';
}
const MAX_TASK_ARTIFACT_BYTES = 20 * 1024 * 1024;
const TASK_ARTIFACT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function decodeTaskArtifactFile(value: unknown): { filename: string; data: Buffer } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error('Artifact file must include filename and base64Data');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some((key) => key !== 'filename' && key !== 'base64Data')) {
    throw new Error('Artifact file must include only filename and base64Data');
  }
  const filenameDescriptor = Object.getOwnPropertyDescriptor(value, 'filename');
  const base64Descriptor = Object.getOwnPropertyDescriptor(value, 'base64Data');
  if (
    !filenameDescriptor ||
    !('value' in filenameDescriptor) ||
    !base64Descriptor ||
    !('value' in base64Descriptor)
  ) {
    throw new Error('Artifact file must include filename and base64Data');
  }
  const rawFilename = filenameDescriptor.value;
  const base64Data = base64Descriptor.value;
  if (
    typeof rawFilename !== 'string' ||
    !rawFilename.trim() ||
    rawFilename.length > 255 ||
    /[\\/:\x00-\x1f\x7f]/u.test(rawFilename) ||
    rawFilename.trim() === '.' ||
    rawFilename.trim() === '..'
  ) {
    throw new Error('Artifact name must be a filename without a directory');
  }
  const filename = rawFilename.trim();
  if (
    typeof base64Data !== 'string' ||
    base64Data.length > Math.ceil(MAX_TASK_ARTIFACT_BYTES / 3) * 4 ||
    base64Data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64Data)
  ) {
    throw new Error('Artifact content must be valid base64 within the 20 MiB limit');
  }
  const data = Buffer.from(base64Data, 'base64');
  if (data.length > MAX_TASK_ARTIFACT_BYTES || data.toString('base64') !== base64Data) {
    throw new Error('Artifact content must be valid base64 within the 20 MiB limit');
  }
  return { filename, data };
}

function taskArtifactRoot(appDataPath: string, teamName: string, taskId: string): string {
  const isSafeSegment = (value: string): boolean =>
    value.length > 0 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    !/[\\/\x00]/u.test(value);
  if (
    !path.isAbsolute(appDataPath) ||
    !isSafeSegment(teamName) ||
    !isSafeSegment(taskId) ||
    taskId.length > 200
  ) {
    throw new Error('Task artifact storage is unavailable');
  }
  const teamRoot = path.resolve(appDataPath, 'task-attachments', teamName);
  const root = path.resolve(teamRoot, taskId);
  const relative = path.relative(teamRoot, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Task artifact storage is unavailable');
  }
  return root;
}

interface TeamNotificationContext {
  displayName: string;
  projectPath?: string;
}

interface TeamNotificationContextCacheEntry {
  value: TeamNotificationContext;
  cachedAt: number;
  generation: number;
}

interface InFlightTeamNotificationContext {
  promise: Promise<TeamNotificationContext>;
  generation: number;
}

function resolveEffectiveMemberProviderId(
  leadProviderId: TeamProviderId | undefined,
  member: ReturnType<typeof toProvisioningMemberShape>[number] | undefined
): TeamProviderId {
  return normalizeOptionalTeamProviderId(member?.providerId) ?? leadProviderId ?? 'anthropic';
}

function isSupportedRunningMixedRosterMutation(params: {
  leadProviderId: TeamProviderId | undefined;
  previousMembers: ReturnType<typeof toProvisioningMemberShape>;
  nextMembers: ReturnType<typeof toProvisioningMemberShape>;
}): boolean {
  if (params.leadProviderId === 'opencode') {
    return false;
  }

  const previousByName = new Map(
    params.previousMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const nextByName = new Map(
    params.nextMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  const candidateNames = new Set([...previousByName.keys(), ...nextByName.keys()]);

  for (const candidateName of candidateNames) {
    const previous = previousByName.get(candidateName);
    const next = nextByName.get(candidateName);
    const previousProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, previous);
    const nextProviderId = resolveEffectiveMemberProviderId(params.leadProviderId, next);

    if (!previous && next) {
      if (nextProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (previous && !next) {
      if (previousProviderId !== 'opencode') {
        return false;
      }
      continue;
    }

    if (!previous || !next) {
      continue;
    }

    if (previousProviderId !== nextProviderId) {
      return false;
    }

    if (previousProviderId !== 'opencode') {
      const stablePrimaryShape = JSON.stringify({
        name: previous.name,
        role: previous.role,
        workflow: previous.workflow,
        isolation: previous.isolation,
        providerId: previous.providerId,
        providerBackendId: previous.providerBackendId,
        model: previous.model,
        effort: previous.effort,
        fastMode: previous.fastMode,
      });
      const nextPrimaryShape = JSON.stringify({
        name: next.name,
        role: next.role,
        workflow: next.workflow,
        isolation: next.isolation,
        providerId: next.providerId,
        providerBackendId: next.providerBackendId,
        model: next.model,
        effort: next.effort,
        fastMode: next.fastMode,
      });
      if (stablePrimaryShape !== nextPrimaryShape) {
        return false;
      }
    }
  }

  return true;
}

interface TaskChangeLogSourceSnapshot {
  projectFingerprint: string | null;
  logSourceGeneration: string | null;
}

interface FileWatchReconcileDiagnostics {
  inFlight: number;
  burstCount: number;
  windowStartedAt: number;
  lastPressureLogAt: number;
}

interface GlobalTaskTeamInfo {
  displayName: string;
  projectPath?: string;
  deletedAt?: string;
}

async function mapLimitLocal<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index]);
      }
    })
  );

  return results;
}

function readConfigForUiSnapshot(
  configReader: TeamConfigReader & {
    getConfigSnapshot?: (teamName: string) => Promise<TeamConfig | null>;
  },
  teamName: string
): Promise<TeamConfig | null> {
  return typeof configReader.getConfigSnapshot === 'function'
    ? configReader.getConfigSnapshot(teamName)
    : configReader.getConfig(teamName);
}

function createUiSnapshotProjectResolver(
  configReader: TeamConfigReader,
  canWriteTeamFiles: TeamFileWritePolicy
): TeamTranscriptProjectResolver {
  return new TeamTranscriptProjectResolver(canWriteTeamFiles, {
    getConfig: (teamName) => readConfigForUiSnapshot(configReader, teamName),
  });
}

function isVisibleRuntimeLeadMember(member: {
  name?: unknown;
  agentType?: unknown;
  role?: unknown;
}): boolean {
  if (isLeadMember(member)) {
    return true;
  }
  return isConversationLeadAlias(typeof member.name === 'string' ? member.name : undefined);
}

function hasVisibleLeadMember(members: readonly TeamMemberSnapshot[]): boolean {
  return members.some(isVisibleRuntimeLeadMember);
}

function hasExplicitLeadInConfig(config: TeamConfig): boolean {
  return (config.members ?? []).some(isVisibleRuntimeLeadMember);
}

function toProvisioningMemberShape(
  members: readonly Pick<
    TeamMember,
    | 'name'
    | 'role'
    | 'workflow'
    | 'isolation'
    | 'providerId'
    | 'providerBackendId'
    | 'model'
    | 'effort'
    | 'fastMode'
    | 'removedAt'
  >[]
): {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId?: TeamProviderId;
  providerBackendId?: TeamMember['providerBackendId'];
  model?: string;
  effort?: TeamMember['effort'];
  fastMode?: TeamMember['fastMode'];
}[] {
  return members
    .filter((member) => !member.removedAt)
    .filter((member) => {
      const normalizedName = member.name.trim();
      return (
        normalizedName.length > 0 && !isLeadMember({ name: normalizedName, agentType: undefined })
      );
    })
    .map((member) => ({
      name: member.name.trim(),
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: normalizeOptionalTeamProviderId(member.providerId),
      providerBackendId: member.providerBackendId,
      model: member.model,
      effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
      fastMode:
        member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
          ? member.fastMode
          : undefined,
    }));
}

interface TaskArtifactRequirementPatch {
  required: boolean;
  expectedFilename?: string;
  proof?: NonNullable<TeamTask['artifactRequirement']>['proof'];
}

interface SnapshotControllerOptions {
  claudeDir: string;
  readOnlyTaskSnapshot: readonly TeamTask[];
}

interface FileWatchReconcileTrigger {
  source: 'inbox' | 'task';
  detail?: string;
}
export class TeamDataService {
  private processHealthTimer: ReturnType<typeof setInterval> | null = null;
  private processHealthTeams = new Set<string>();
  private processHealthTickInFlight = false;
  /** Tracks notified task-start transitions to avoid duplicate lead notifications. */
  private notifiedTaskStarts = new Set<string>();
  private taskChangePresenceRepository: TaskChangePresenceRepository | null = null;
  private teamLogSourceTracker: TeamLogSourceTracker | null = null;
  private fileWatchReconcileDiagnostics = new Map<string, FileWatchReconcileDiagnostics>();
  private readonly messageFeedService: TeamMessageFeedService;
  private readonly memberActivityMetaService: MemberActivityMetaService;
  private readonly notificationContextCache = new Map<string, TeamNotificationContextCacheEntry>();
  private readonly notificationContextInFlight = new Map<string, InFlightTeamNotificationContext>();
  private readonly notificationContextGenerationByTeam = new Map<string, number>();
  private taskGroupChatCatalog: TaskGroupChatCatalog | null = null;
  /**
   * Until wired, no team counts as this profile's, so lead notifications and transcript
   * lookups write nothing under a team directory and process listings only read. The
   * team data worker is never wired.
   */
  private teamProfileOwnership: (teamName: string) => Promise<boolean> = () =>
    Promise.resolve(false);
  private readonly projectResolver: TeamTranscriptProjectResolver;
  private registryTaskProviderInstance: RegistryTaskProvider | undefined;
  private readonly boardSnapshots: RegistryBoardSnapshotReadPort;
  private readonly registryTasks: TeamDataRegistryTaskOperations;
  private readonly taskEvents: TeamDataTaskEvents;
  private readonly taskProjection = new TeamDataTaskSnapshotProjection();

  private get registryTaskProvider(): RegistryTaskProvider {
    this.registryTaskProviderInstance ??= new RegistryTaskProvider({
      readConfig: (teamName) => this.registryTasks.readRegistryBindingConfig(teamName),
    });
    return this.registryTaskProviderInstance;
  }

  constructor(
    private readonly runtimeSnapshot: (teamName: string) => Promise<TeamAgentRuntimeSnapshot>,
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly memberResolver: TeamMemberResolver = new TeamMemberResolver(),
    private readonly kanbanManager: TeamKanbanManager = new TeamKanbanManager(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly controllerFactory: (
      teamName: string,
      options?: {
        claudeDir?: string;
        readOnlyTaskSnapshot?: readonly TeamTask[];
      }
    ) => AgentTeamsController = (teamName, options) =>
      createController({
        teamName,
        claudeDir: options?.claudeDir ?? getClaudeBasePath(),
        ...(options?.readOnlyTaskSnapshot
          ? { readOnlyTaskSnapshot: options.readOnlyTaskSnapshot }
          : {}),
      }),
    private readonly taskCommentNotificationJournal: TeamTaskCommentNotificationJournal = new TeamTaskCommentNotificationJournal(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private memberRuntimeAdvisoryService: TeamMemberRuntimeAdvisoryService = new TeamMemberRuntimeAdvisoryService(),
    private readonly leadSessionParseCache: LeadSessionParseCache = new LeadSessionParseCache(),
    projectResolver?: TeamTranscriptProjectResolver,
    private readonly launchStateStore: TeamLaunchStateStore = new TeamLaunchStateStore(),
    registryTaskWriterProvider?: TeamRegistryTaskWriterProvider,
    registryTaskProvider?: RegistryTaskProvider,
    private readonly executionTaskStore: ExecutionTaskStore = new ExecutionTaskStore(),
    private readonly taskAttachmentStore: TeamTaskAttachmentStore = new TeamTaskAttachmentStore(),
    // The team data service also runs inside a worker thread, where Electron's
    // module is unavailable. Load the protected key store only when a caller
    // actually needs signing, so the worker graph never pulls it in.
    private readonly taskSigningKeyStoreFactory: () => Promise<DesktopSigningKeyStore> = async () =>
      (await import('../identity/DesktopSigningKeyStore')).DesktopSigningKeyStore.open(),
    private readonly taskAttestationJournal: TaskAttestationJournal = new TaskAttestationJournal(
      getTeamsBasePath()
    ),
    boardSnapshots?: RegistryBoardSnapshotReadPort
  ) {
    this.registryTaskProviderInstance = registryTaskProvider;
    this.boardSnapshots = boardSnapshots ?? {
      readBoardSnapshot: (teamName, options) =>
        this.registryTaskProvider.readBoardSnapshot(teamName, options),
    };
    this.registryTasks = new TeamDataRegistryTaskOperations(
      configReader,
      teamMetaStore,
      (name) => this.readSnapshotConfig(name),
      () => this.registryTaskProvider,
      taskSigningKeyStoreFactory,
      registryTaskWriterProvider
    );
    this.taskEvents = new TeamDataTaskEvents(
      () => this.listTeams(),
      (name) => this.getTasks(name),
      (name) => this.readSnapshotConfig(name),
      (name) => this.isTeamManagedByThisProfile(name),
      inboxReader,
      inboxWriter,
      taskCommentNotificationJournal
    );
    this.projectResolver =
      projectResolver ??
      createUiSnapshotProjectResolver(configReader, (teamName) =>
        this.isTeamManagedByThisProfile(teamName)
      );
    const getInboxMessagesWindow =
      typeof this.inboxReader.getMessagesWindow === 'function'
        ? (teamName: string, options: Parameters<TeamInboxReader['getMessagesWindow']>[1]) =>
            this.inboxReader.getMessagesWindow(teamName, options)
        : undefined;

    this.messageFeedService = new TeamMessageFeedService({
      getConfig: (teamName) => this.readSnapshotConfig(teamName),
      getInboxMessages: (teamName) => this.inboxReader.getMessages(teamName),
      getInboxMessagesWindow,
      getLeadSessionMessages: (teamName, config) => this.extractLeadSessionTexts(teamName, config),
      getSentMessages: (teamName) => this.sentMessagesStore.readMessages(teamName),
    });
    this.memberActivityMetaService = new MemberActivityMetaService(this.messageFeedService);
  }

  private readSnapshotConfig(teamName: string): Promise<TeamConfig | null> {
    return readConfigForUiSnapshot(this.configReader, teamName);
  }

  async readTasks(teamName: string): Promise<TeamTask[]> {
    return this.getTasks(teamName);
  }

  async getTasks(teamName: string, binding?: RegistryTaskScope): Promise<TeamTask[]> {
    return this.readBoardSnapshot(teamName, { binding });
  }

  private async requireRegistryTaskScope(teamName: string): Promise<void> {
    try {
      const authority = await this.registryTasks.readRegistryTaskAuthority(teamName);
      if (!authority.backed || !authority.config) {
        throw new RegistryTaskProviderError({
          code: 'REGISTRY_SCOPE_INCOMPLETE',
          teamName,
          message: `Team "${teamName}" has no configured registry task scope.`,
        });
      }
      resolveTeamSpecScope(authority.config, teamName);
    } catch (error) {
      if (!(error instanceof TeamSpecBindingError)) throw error;
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        causeCode: error.code,
        message: error.message,
      });
    }
  }

  async readBoardSnapshot(
    teamName: string,
    options: RegistryBoardSnapshotReadOptions = {}
  ): Promise<TeamTask[]> {
    await this.requireRegistryTaskScope(teamName);
    return this.boardSnapshots.readBoardSnapshot(teamName, options);
  }

  async discoverSpecRegistry() {
    return discoverSpecRegistry();
  }

  /** Launch admission checks all permitted projects, even before the first spec exists. */
  async readSpecBindingConfigForGate(teamName: string): Promise<TeamSpecScope | null> {
    const config = await this.registryTasks.readRegistryBindingConfig(teamName);
    return config?.specScope ? resolveTeamSpecScope(config, teamName) : null;
  }

  /**
   * Bindings live in the team configuration; the registry has no listing tool,
   * so this read never leaves the app.
   */
  async listTeamSpecBindings(teamName: string): Promise<TeamSpecBinding[]> {
    const config = await this.registryTasks.readRegistryBindingConfig(teamName);
    if (!config) throw new Error(`Team "${teamName}" was not found.`);
    try {
      return resolveTeamSpecBindings(config, teamName);
    } catch (error) {
      if (error instanceof TeamSpecBindingError) throw new Error(error.message);
      throw error;
    }
  }

  async linkTeamSpec(
    teamName: string,
    requestedBinding: TeamSpecBinding
  ): Promise<TeamSpecBinding[]> {
    const binding = validateSpecBinding(requestedBinding, teamName);
    const config = await this.registryTasks.readRegistryBindingConfig(teamName);
    if (!config) throw new Error(`Team "${teamName}" was not found.`);
    if (!resolveTeamSpecScope(config, teamName).projects.includes(binding.project)) {
      throw new TeamSpecBindingError(
        'SPEC_PROJECT_INVALID',
        teamName,
        'The specification is outside the permitted projects'
      );
    }
    // Bindings live in the team configuration: the registry has no tool that
    // lists or links them, so a link is a local write, not a remote call.
    const existing = await this.listTeamSpecBindings(teamName);
    const bindings = existing.some(
      (candidate) => candidate.project === binding.project && candidate.spec === binding.spec
    )
      ? existing
      : [...existing, binding];
    await this.registryTasks.persistRegistryBindings(teamName, bindings);
    this.registryTasks.invalidateWriter(teamName);
    return bindings;
  }

  async unlinkTeamSpec(teamName: string, binding: TeamSpecBinding): Promise<TeamSpecBinding[]> {
    // Bindings are configuration; removing one is a local write.
    const existing = await this.listTeamSpecBindings(teamName);
    const bindings = existing.filter(
      (candidate) => !(candidate.project === binding.project && candidate.spec === binding.spec)
    );
    await this.registryTasks.persistRegistryBindings(teamName, bindings);
    this.registryTasks.invalidateWriter(teamName);
    return bindings;
  }

  private getNotificationContextGeneration(teamName: string): number {
    return this.notificationContextGenerationByTeam.get(teamName) ?? 0;
  }

  private invalidateNotificationContext(teamName: string): void {
    this.notificationContextCache.delete(teamName);
    this.notificationContextGenerationByTeam.set(
      teamName,
      this.getNotificationContextGeneration(teamName) + 1
    );
  }

  private async readGlobalTaskTeamInfoFromListTeams(): Promise<Map<string, GlobalTaskTeamInfo>> {
    const teams = await this.configReader.listTeams();
    const teamInfoMap = new Map<string, GlobalTaskTeamInfo>();
    for (const team of teams) {
      teamInfoMap.set(team.teamName, {
        displayName: team.displayName,
        projectPath: team.projectPath,
        deletedAt: team.deletedAt,
      });
    }
    return teamInfoMap;
  }

  private async readGlobalTaskTeamInfo(
    rawTasks: readonly (TeamTask & { teamName: string })[]
  ): Promise<Map<string, GlobalTaskTeamInfo>> {
    const canReadConfigDirectly =
      typeof (this.configReader as { getConfigSnapshot?: unknown }).getConfigSnapshot ===
        'function' ||
      typeof (this.configReader as { getConfig?: unknown }).getConfig === 'function';
    if (!canReadConfigDirectly) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    const teamNames = [...new Set(rawTasks.map((task) => task.teamName))];
    const entries = await mapLimitLocal(
      teamNames,
      GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY,
      async (teamName) => {
        const config = await readConfigForUiSnapshot(this.configReader, teamName).catch(() => null);
        const displayName = config?.name?.trim();
        if (!config || !displayName) {
          return null;
        }
        return [
          teamName,
          {
            displayName,
            projectPath: resolveProjectPathFromConfig(config),
            deletedAt: typeof config.deletedAt === 'string' ? config.deletedAt : undefined,
          },
        ] as const;
      }
    );

    if (entries.some((entry) => entry === null)) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }

  private invalidateGlobalTaskProjectionCache(teamName: string): void {
    this.registryTaskProvider.invalidateTeamBoard(teamName);
  }

  private async readTasksForUiSnapshot(teamName: string): Promise<readonly TeamTask[]> {
    const startedAt = Date.now();
    try {
      const tasks = await this.readTasks(teamName);
      logTaskReadStages(teamName, 0, Date.now() - startedAt, tasks.length);
      return tasks;
    } catch (error) {
      if (error instanceof RegistryTaskProviderError || error instanceof TeamSpecBindingError) {
        throw error;
      }
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_UNAVAILABLE',
        teamName,
        message: `The spec registry could not confirm task state for team "${teamName}".`,
        causeCode: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
  }

  createController(input: {
    teamName: string;
    claudeDir: string;
    readOnlyTaskSnapshot: readonly TeamTask[];
  }): AgentTeamsController {
    return this.controllerFactory(input.teamName, {
      claudeDir: input.claudeDir,
      readOnlyTaskSnapshot: input.readOnlyTaskSnapshot,
    });
  }

  private getController(teamName: string): AgentTeamsController {
    return this.controllerFactory(teamName);
  }

  private async readTeamLaneMutationContext(teamName: string): Promise<{
    leadProviderId: TeamProviderId | undefined;
    activeMembers: ReturnType<typeof toProvisioningMemberShape>;
    currentMixed: boolean;
  }> {
    const [teamMeta, activeMembersRaw, bootstrapSnapshot, persistedLaunchSnapshot] =
      await Promise.all([
        this.teamMetaStore.getMeta(teamName).catch(() => null),
        this.membersMetaStore.getMembers(teamName).catch(() => []),
        readBootstrapLaunchSnapshot(teamName).catch(() => null),
        this.launchStateStore.read(teamName).catch(() => null),
      ]);

    const preferredLaunchSnapshot = choosePreferredLaunchSnapshot(
      bootstrapSnapshot,
      persistedLaunchSnapshot
    );
    const leadProviderId =
      teamMeta?.launchIdentity?.providerId ?? normalizeOptionalTeamProviderId(teamMeta?.providerId);
    const activeMembers = toProvisioningMemberShape(activeMembersRaw);
    const currentPlan = fromProvisioningMembers(leadProviderId, activeMembers);
    const currentMixed =
      hasMixedPersistedLaunchMetadata(preferredLaunchSnapshot) ||
      (currentPlan.ok && isMixedOpenCodeSideLanePlan(currentPlan.plan));

    return {
      leadProviderId,
      activeMembers,
      currentMixed,
    };
  }

  private async assertRosterMutationAllowed(
    teamName: string,
    nextMembers: ReturnType<typeof toProvisioningMemberShape>
  ): Promise<void> {
    const context = await this.readTeamLaneMutationContext(teamName);
    const nextPlan = fromProvisioningMembers(context.leadProviderId, nextMembers);
    if (!nextPlan.ok) {
      throw new Error(nextPlan.message);
    }
    const nextMixed = isMixedOpenCodeSideLanePlan(nextPlan.plan);
    if (!(context.currentMixed || nextMixed)) {
      return;
    }
    const isRunning = (await this.readProcesses(teamName)).some((process) => !process.stoppedAt);
    if (isRunning) {
      if (
        !isSupportedRunningMixedRosterMutation({
          leadProviderId: context.leadProviderId,
          previousMembers: context.activeMembers,
          nextMembers,
        })
      ) {
        throw new Error(MIXED_TEAM_LIVE_MUTATION_BLOCK_MESSAGE);
      }
    }
  }

  setMemberRuntimeAdvisoryService(service: TeamMemberRuntimeAdvisoryService): void {
    this.memberRuntimeAdvisoryService = service;
  }

  setTaskGroupChatCatalog(catalog: TaskGroupChatCatalog): void {
    this.taskGroupChatCatalog = catalog;
  }

  /** Composition-time backend swap; must run before notification processing starts. */
  setTaskCommentNotificationJournalStore(store: TaskCommentNotificationJournalStore): void {
    this.taskCommentNotificationJournal.setStore(store);
  }

  /**
   * ~/.claude/teams is shared with other app profiles and native sessions. Lead
   * notifications about teammate task starts and comments write the team's
   * comment journal and lead inbox, so they run only for teams this profile manages.
   * The same check decides whether transcript lookups may write the team's transcript
   * index or repair the projectPath in its config.json.
   */
  setTeamProfileOwnership(isManagedByThisProfile: (teamName: string) => Promise<boolean>): void {
    this.teamProfileOwnership = isManagedByThisProfile;
  }

  /** The wired ownership check; background writers into a team ask it first. */
  isTeamManagedByThisProfile(teamName: string): Promise<boolean> {
    return this.teamProfileOwnership(teamName);
  }

  invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void {
    this.memberRuntimeAdvisoryService.invalidateMemberAdvisory(teamName, memberName);
  }

  invalidateTeamRuntimeAdvisories(teamName: string, runStartedAtMs?: number): void {
    this.memberRuntimeAdvisoryService.invalidateTeamAdvisories(teamName, runStartedAtMs);
  }

  private async getMemberRuntimeAdvisoriesForSnapshot(
    teamName: string,
    members: readonly Pick<TeamMemberSnapshot, 'name' | 'removedAt'>[],
    observedAfterMs: number | null = null
  ): Promise<Map<string, NonNullable<TeamMemberSnapshot['runtimeAdvisory']>>> {
    const request = this.memberRuntimeAdvisoryService.getMemberAdvisories(teamName, members, {
      observedAfterMs,
    });
    const timeoutToken = Symbol('member-runtime-advisory-timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<typeof timeoutToken>((resolve) => {
      timeoutHandle = setTimeout(resolve, MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS, timeoutToken);
    });

    let result: Awaited<typeof request> | typeof timeoutToken;
    try {
      result = await Promise.race([request, timeout]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
    if (result === timeoutToken) {
      request.catch(() => {
        /* background advisory refresh is best-effort */
      });
      logger.debug(
        `getTeamData team=${teamName} member runtime advisories exceeded ${MEMBER_RUNTIME_ADVISORY_SNAPSHOT_BUDGET_MS}ms budget; continuing without advisories for this snapshot`
      );
      return new Map();
    }

    return result;
  }

  private getRuntimeAdvisoryObservedAfterMs(
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): number | null {
    if (!launchSnapshot) {
      return null;
    }

    const candidates = [
      launchSnapshot.updatedAt,
      ...Object.values(launchSnapshot.members).flatMap((member) => [
        member.lastEvaluatedAt,
        member.firstSpawnAcceptedAt,
        member.lastHeartbeatAt,
      ]),
    ];
    const validTimes = candidates
      .map((value) => (typeof value === 'string' ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value) && value > 0);
    return validTimes.length > 0 ? Math.min(...validTimes) : null;
  }

  private async synthesizeLeadMemberIfMissing(
    teamName: string,
    config: TeamConfig,
    members: TeamMemberSnapshot[],
    tasks: TeamTaskWithKanban[],
    teamMeta?: TeamMetaFile | null
  ): Promise<void> {
    if (hasVisibleLeadMember(members) || hasExplicitLeadInConfig(config)) {
      return;
    }

    if (typeof teamMeta === 'undefined') {
      try {
        teamMeta = await this.teamMetaStore.getMeta(teamName);
      } catch {
        teamMeta = null;
      }
    }

    const leadName = 'team-lead';
    const ownedTasks = tasks.filter((task) => task.owner === leadName);
    const currentTask = selectCurrentActiveTeamTask(ownedTasks);

    members.unshift({
      name: leadName,
      agentId: undefined,
      currentTaskId: currentTask?.id ?? null,
      taskCount: ownedTasks.length,
      color: getMemberColorByName(leadName),
      agentType: 'team-lead',
      role: 'Team Lead',
      workflow: undefined,
      isolation: undefined,
      ...resolveSyntheticLeadRuntimeSettings(teamMeta),
      laneId: 'primary',
      laneKind: 'primary',
      cwd: config.projectPath ?? teamMeta?.cwd,
      removedAt: undefined,
    });
  }

  private getTaskLabel(task: Pick<TeamTask, 'id' | 'displayId'>): string {
    return formatTaskDisplayLabel(task);
  }

  async getTask(
    teamName: string,
    taskId: string,
    binding?: RegistryTaskScope
  ): Promise<TeamTaskWithKanban | null> {
    await this.requireRegistryTaskScope(teamName);
    const task = await this.registryTaskProvider.readTaskSnapshot(teamName, taskId, binding);
    if (!task) return null;
    let kanbanState: KanbanState = { teamName, reviewers: [], tasks: {} };
    try {
      kanbanState = await this.kanbanManager.getState(teamName);
    } catch {
      // Local kanban presentation state is not canonical task authority.
    }
    return this.taskProjection.attachKanbanCompatibility(task, kanbanState.tasks[task.id]);
  }

  setTaskChangePresenceServices(
    repository: TaskChangePresenceRepository,
    tracker: TeamLogSourceTracker
  ): void {
    this.taskChangePresenceRepository = repository;
    this.teamLogSourceTracker = tracker;
  }

  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void {
    if (!this.teamLogSourceTracker) {
      return;
    }

    if (enabled) {
      void this.teamLogSourceTracker
        .enableTracking(teamName, 'change_presence')
        .catch((error) =>
          logger.debug(`Failed to start change-presence tracking for ${teamName}: ${String(error)}`)
        );
      return;
    }

    void this.teamLogSourceTracker
      .disableTracking(teamName, 'change_presence')
      .catch((error) =>
        logger.debug(`Failed to stop change-presence tracking for ${teamName}: ${String(error)}`)
      );
  }

  private isLeadThoughtCandidateForSlashResult(message: InboxMessage): boolean {
    if (typeof message.to === 'string' && message.to.trim().length > 0) return false;
    if (message.from === 'system') return false;
    return message.source === 'lead_session' || message.source === 'lead_process';
  }

  private annotateSlashCommandResponses(messages: InboxMessage[]): void {
    let pendingSlash = null as InboxMessage['slashCommand'] | null;

    for (const message of messages) {
      const slashCommand =
        message.source === 'user_sent'
          ? (message.slashCommand ?? buildStandaloneSlashCommandMeta(message.text))
          : null;

      if (slashCommand) {
        pendingSlash = slashCommand;
        continue;
      }

      if (!pendingSlash) {
        continue;
      }

      if (message.messageKind === 'slash_command_result') {
        continue;
      }

      if (this.isLeadThoughtCandidateForSlashResult(message)) {
        message.messageKind = 'slash_command_result';
        message.commandOutput = {
          stream: 'stdout',
          commandLabel: pendingSlash.command,
        };
        continue;
      }

      pendingSlash = null;
    }
  }

  async getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>> {
    const config = await this.readSnapshotConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }

    const changePresenceEnabled =
      this.taskChangePresenceRepository !== null && this.teamLogSourceTracker !== null;
    const logSourceSnapshot: TaskChangeLogSourceSnapshot | null =
      changePresenceEnabled &&
      typeof (this.teamLogSourceTracker as { getSnapshot?: (teamName: string) => unknown })
        .getSnapshot === 'function'
        ? ((
            this.teamLogSourceTracker as {
              getSnapshot: (teamName: string) => TaskChangeLogSourceSnapshot | null;
            }
          ).getSnapshot(teamName) ?? null)
        : null;

    const [snapshot, presenceIndex] = await Promise.all([
      readConsistentTaskSnapshot(this.kanbanManager, teamName, () =>
        this.readTasksForUiSnapshot(teamName)
      ),
      changePresenceEnabled &&
      logSourceSnapshot?.projectFingerprint &&
      logSourceSnapshot.logSourceGeneration
        ? this.taskChangePresenceRepository!.load(teamName)
        : Promise.resolve(null),
    ]);

    const tasksWithKanbanBase: TeamTaskWithKanban[] = snapshot.tasks.map((task) =>
      this.taskProjection.attachKanbanCompatibility(task, snapshot.kanbanState.tasks[task.id])
    );

    return this.taskProjection.resolveTaskChangePresenceMap(
      tasksWithKanbanBase,
      changePresenceEnabled,
      presenceIndex,
      logSourceSnapshot
    );
  }

  async listTeams(): Promise<TeamSummary[]> {
    return this.configReader.listTeams();
  }

  async getSavedRequest(teamName: string): Promise<TeamCreateRequest | null> {
    const meta = await this.teamMetaStore.getMeta(teamName);
    if (!meta) {
      return null;
    }

    const membersMeta = await this.membersMetaStore.getMeta(teamName);
    const members = membersMeta?.members ?? [];
    const selection = resolveTeamRuntimeSelection(meta);
    const resolvedProviderId = selection.status === 'selected' ? selection.providerId : undefined;
    return {
      teamName,
      specScope: meta.specScope,
      displayName: meta.displayName,
      description: meta.description,
      color: meta.color,
      cwd: meta.cwd,
      prompt: meta.prompt,
      savedSettingsFingerprint: fingerprintSavedLaunchSettings(meta),
      runtimeSelectionVersion: meta.runtimeSelectionVersion,
      providerId: resolvedProviderId,
      providerBackendId: migrateProviderBackendId(
        resolvedProviderId,
        meta.providerBackendId ?? membersMeta?.providerBackendId
      ),
      model: meta.model,
      effort: meta.effort as TeamCreateRequest['effort'],
      fastMode: meta.fastMode,
      syncModelsWithLead: meta.syncModelsWithLead,
      skipPermissions: meta.skipPermissions,
      worktree: meta.worktree,
      extraCliArgs: meta.extraCliArgs,
      limitContext: meta.limitContext,
      members: members
        .filter((member) => !member.removedAt && !isCanonicalSettingsLeadMember(member))
        .map((member) => ({
          name: member.name,
          role: member.role,
          workflow: member.workflow,
          isolation: member.isolation,
          cwd: member.cwd,
          providerId: member.providerId,
          providerBackendId: member.providerBackendId,
          model: member.model,
          effort: member.effort,
          fastMode: member.fastMode,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
        })),
    };
  }

  async listAliveProcessTeams(): Promise<string[]> {
    const teams = await this.listTeams();
    const alive: string[] = [];

    for (const team of teams) {
      if (team.deletedAt) {
        continue;
      }
      try {
        const processes = await this.readProcesses(team.teamName);
        if (processes.some((process) => !process.stoppedAt)) {
          alive.push(team.teamName);
        }
      } catch {
        // best-effort per team
      }
    }

    return alive.sort((left, right) => left.localeCompare(right));
  }

  async getAllTasks(): Promise<GlobalTask[]> {
    const { tasks, failures } = await this.getAllTasksWithDiagnostics();
    const firstFailure = failures[0];
    if (firstFailure) {
      throw new Error(`Global task board unavailable for ${firstFailure.teamName}`);
    }
    return tasks;
  }

  async getAllTasksWithDiagnostics(): Promise<{
    tasks: GlobalTask[];
    failures: Array<{
      teamName: string;
      project?: string;
      spec?: string;
      code: string;
      message: string;
    }>;
  }> {
    interface BoardFailure {
      teamName: string;
      project?: string;
      spec?: string;
      code: string;
      message: string;
    }
    const kanbanByTeam = new Map<string, KanbanState>();
    const teams = await this.configReader.listTeams();
    const teamResults = await mapLimitLocal(
      teams,
      GLOBAL_TASK_TEAM_CONFIG_CONCURRENCY,
      async (
        team
      ): Promise<{
        tasks: Array<TeamTask & { teamName: string }>;
        failure?: BoardFailure;
      }> => {
        const teamName = team.teamName;
        try {
          const authority = await this.registryTasks.readRegistryTaskAuthority(teamName);
          resolveTeamSpecScope(authority.config, teamName);
          if (!authority.config) {
            throw new RegistryTaskProviderError({
              code: 'REGISTRY_SCOPE_INCOMPLETE',
              teamName,
              message: `Team "${teamName}" registry binding is unavailable.`,
            });
          }
          const tasks = await this.readBoardSnapshot(teamName, {
            refresh: false,
          });
          return {
            tasks: tasks.map((task) => ({ ...task, teamName })),
          };
        } catch (error) {
          if (error instanceof RegistryTaskProviderError) {
            return {
              tasks: [],
              failure: {
                teamName,
                code: error.code,
                message: error.message,
                ...(error.project ? { project: error.project } : {}),
                ...(error.spec ? { spec: error.spec } : {}),
              },
            };
          }
          if (error instanceof TeamSpecBindingError) {
            const config = await this.readSnapshotConfig(teamName).catch(() => null);
            const firstBinding = config?.specScope?.bindings[0];
            const project = firstBinding?.project ?? config?.specScope?.projects[0];
            const spec = firstBinding?.spec;
            return {
              tasks: [],
              failure: {
                teamName,
                code: error.code,
                message: error.message,
                ...(project ? { project } : {}),
                ...(spec ? { spec } : {}),
              },
            };
          }
          throw error;
        }
      }
    );
    const failures = teamResults.flatMap((result) => (result.failure ? [result.failure] : []));
    const rawTasks = teamResults.flatMap((result) => result.tasks);
    const teamInfoMap = await this.readGlobalTaskTeamInfo(rawTasks);

    const MAX_GLOBAL_TASKS_EXPORTED = 500;
    let tasksToExport = rawTasks.filter((task) => teamInfoMap.has(task.teamName));
    if (tasksToExport.length > MAX_GLOBAL_TASKS_EXPORTED) {
      // Prefer newest first before reading kanban and building the lightweight IPC projection.
      tasksToExport = tasksToExport
        .slice()
        .sort((a, b) => {
          const at = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
          const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
          return bt - at;
        })
        .slice(0, MAX_GLOBAL_TASKS_EXPORTED);
    }

    const teamNames = [...new Set(tasksToExport.map((task) => task.teamName))];
    await Promise.all(
      teamNames.map(async (teamName) => {
        if (kanbanByTeam.has(teamName)) return;
        try {
          const state = await this.kanbanManager.getState(teamName);
          kanbanByTeam.set(teamName, state);
        } catch (error) {
          throwIfKanbanOutcomeUnknown(error);
          // ignore
        }
      })
    );

    const out: GlobalTask[] = [];
    let processed = 0;
    for (const task of tasksToExport) {
      const info = teamInfoMap.get(task.teamName)!;
      const kanbanTaskState = kanbanByTeam.get(task.teamName)?.tasks[task.id];
      const reviewState = this.taskProjection.resolveTaskReviewState(task, kanbanTaskState);
      const kanbanColumn = this.taskProjection.resolveTaskKanbanColumn(
        task,
        kanbanTaskState,
        reviewState
      );

      // IPC payload safety: GlobalTask lists can be enormous (especially comments and large nested fields).
      // Return a "light" task object and defer heavy details to team/task detail views.
      const projectPath = task.projectPath ?? info.projectPath;
      const subject =
        typeof task.subject === 'string'
          ? task.subject.slice(0, 300)
          : String(task.subject).slice(0, 300);
      out.push({
        id: task.id,
        subject,
        owner: task.owner,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        projectPath,
        needsClarification: task.needsClarification,
        deletedAt: task.deletedAt,
        reviewState,
        // Keep dependency state in the lightweight snapshot. Otherwise opening a
        // team hydrates old blockers and the renderer reports them as new.
        blockedBy: Array.isArray(task.blockedBy)
          ? task.blockedBy.filter((id): id is string => typeof id === 'string')
          : undefined,
        // IMPORTANT: comments MUST be included here (at least lightweight metadata).
        //
        // Previously comments were omitted from GlobalTask payload to keep IPC small.
        // This silently broke task comment notifications in the renderer: the store's
        // detectTaskCommentNotifications() compares oldTask.comments vs newTask.comments
        // to find new comments and fire native OS toasts. Without comments in the payload,
        // both counts were always 0 → newCommentCount <= oldCommentCount → every comment
        // was silently skipped → "Task comment notifications" toggle had no effect.
        //
        // Fix: include lightweight comment metadata (id, author, truncated text for toast
        // preview, createdAt, type). Full text and attachments are still omitted — those
        // are loaded on-demand by the task detail view via team:getTask.
        comments: Array.isArray(task.comments)
          ? task.comments.map((c) => ({
              id: c.id,
              author: c.author,
              text: c.text.slice(0, 120),
              createdAt: c.createdAt,
              type: c.type,
            }))
          : undefined,
        kanbanColumn,
        teamName: task.teamName,
        teamDisplayName: info.displayName,
        teamDeleted: Boolean(info.deletedAt) || undefined,
      });
      processed++;
      if (processed % TASK_MAP_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }

    return { tasks: out, failures };
  }

  private configurationGate: (teamName: string, operation: () => Promise<void>) => Promise<void> = (
    _name,
    operation
  ) => operation();

  private configurationIdentityFence: (
    teamName: string,
    operation: () => Promise<void>
  ) => Promise<void> = (_name, operation) => operation();

  setConfigurationIdentityFence(
    fence: (teamName: string, operation: () => Promise<void>) => Promise<void>
  ): void {
    this.configurationIdentityFence = fence;
  }

  setConfigurationGate(
    gate: (teamName: string, operation: () => Promise<void>) => Promise<void>
  ): void {
    this.configurationGate = gate;
  }

  async runConfigurationOperation<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    let result!: T;
    const lockName = teamName.trim().toLowerCase();
    await this.configurationIdentityFence(lockName, () =>
      this.configurationGate(lockName, async () => {
        result = await operation();
      })
    );
    return result;
  }

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    return this.runConfigurationOperation(teamName, () =>
      updateTeamConfiguration(teamName, updates, {
        configReader: this.configReader,
        teamMetaStore: this.teamMetaStore,
        invalidate: (name) => this.invalidateNotificationContext(name),
      })
    );
  }

  async deleteTeam(teamName: string): Promise<void> {
    return this.runConfigurationOperation(teamName, () =>
      setTeamDeleted(teamName, true, {
        configReader: this.configReader,
        teamMetaStore: this.teamMetaStore,
        invalidate: (name) => this.invalidateNotificationContext(name),
      })
    );
  }

  async restoreTeam(teamName: string): Promise<void> {
    return this.runConfigurationOperation(teamName, () =>
      setTeamDeleted(teamName, false, {
        configReader: this.configReader,
        teamMetaStore: this.teamMetaStore,
        invalidate: (name) => this.invalidateNotificationContext(name),
      })
    );
  }

  async permanentlyDeleteTeam(
    teamName: string,
    isTeamDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    isTaskDataCurrent: (detachedPath?: string) => Promise<boolean> = async () => true,
    options: PermanentTeamDataDeletionOptions = {}
  ): Promise<boolean> {
    return this.runConfigurationOperation(teamName, () =>
      permanentlyDeleteTeamData({
        teamName,
        isTeamDataCurrent,
        isTaskDataCurrent,
        options,
        onTeamDataDeleted: () => {
          TeamConfigReader.invalidateTeam(teamName);
          this.invalidateNotificationContext(teamName);
        },
        onTaskDataDeleted: () => this.registryTaskProvider.invalidateTeamBoard(teamName),
      })
    );
  }

  async getTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot> {
    const includeMemberBranches = options?.includeMemberBranches !== false;
    const startedAt = Date.now();
    const marks: Record<string, number> = {};
    const mark = (label: string): void => {
      marks[label] = Date.now();
    };
    const msSince = (label: string): number => {
      const t = marks[label];
      return typeof t === 'number' ? t - startedAt : -1;
    };
    const msBetween = (from: string, to: string): number => {
      const fromTs = marks[from];
      const toTs = marks[to];
      return typeof fromTs === 'number' && typeof toTs === 'number' ? toTs - fromTs : -1;
    };

    const config = await this.readSnapshotConfig(teamName);
    if (!config) {
      throw new Error(`Team not found: ${teamName}`);
    }
    mark('config');

    const warnings: string[] = [];
    interface StepResult<T> {
      value: T;
      warning?: string;
      completedAt: number;
    }
    const startReadStep = <T>(options: {
      label: string;
      createFallback: () => T;
      warningText?: string;
      load: () => Promise<T>;
    }): Promise<StepResult<T>> => {
      const { label, createFallback, warningText, load } = options;
      void label;
      return (async () => {
        try {
          const value = await load();
          return {
            value,
            completedAt: Date.now(),
          };
        } catch (error) {
          if (error instanceof RegistryTaskProviderError || error instanceof TeamSpecBindingError) {
            throw error;
          }
          throwIfKanbanOutcomeUnknown(error);
          return {
            value: createFallback(),
            warning: warningText,
            completedAt: Date.now(),
          };
        }
      })();
    };
    const runWithConcurrencyLimit = (() => {
      const limit = 2;
      let active = 0;
      const queue: (() => void)[] = [];
      const releaseNext = (): void => {
        if (active >= limit) return;
        const next = queue.shift();
        if (next) next();
      };
      return <T>(start: () => Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const run = (): void => {
            active += 1;
            void start()
              .then(resolve, reject)
              .finally(() => {
                active = Math.max(0, active - 1);
                releaseNext();
              });
          };
          if (active < limit) {
            run();
            return;
          }
          queue.push(run);
        });
    })();
    const changePresenceEnabled =
      this.taskChangePresenceRepository !== null && this.teamLogSourceTracker !== null;
    const logSourceSnapshot: TaskChangeLogSourceSnapshot | null =
      changePresenceEnabled &&
      typeof (this.teamLogSourceTracker as { getSnapshot?: (teamName: string) => unknown })
        .getSnapshot === 'function'
        ? ((
            this.teamLogSourceTracker as {
              getSnapshot: (teamName: string) => TaskChangeLogSourceSnapshot | null;
            }
          ).getSnapshot(teamName) ?? null)
        : null;
    const presenceIndexPromise =
      changePresenceEnabled &&
      logSourceSnapshot?.projectFingerprint &&
      logSourceSnapshot.logSourceGeneration
        ? this.taskChangePresenceRepository!.load(teamName)
        : Promise.resolve(null);

    const inboxNamesStep = startReadStep({
      label: 'inboxNames',
      createFallback: () => [],
      warningText: 'Inboxes failed to load',
      load: () => this.inboxReader.listInboxNames(teamName),
    });
    const metaMembersStep = startReadStep({
      label: 'metaMembers',
      createFallback: () => [],
      warningText: 'Member metadata failed to load',
      load: () => this.membersMetaStore.getMembers(teamName),
    });
    const teamMetaStep = startReadStep({
      label: 'teamMeta',
      createFallback: () => null,
      warningText: 'Team runtime metadata failed to load',
      load: () => this.teamMetaStore.getMeta(teamName),
    });
    const launchStateStep = startReadStep({
      label: 'launchState',
      createFallback: () => null,
      warningText: 'Launch state failed to load',
      load: async () => {
        const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
          readBootstrapLaunchSnapshot(teamName),
          this.launchStateStore.read(teamName),
        ]);
        return choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
      },
    });
    const taskBoardStep = runWithConcurrencyLimit(() =>
      startReadStep({
        label: 'tasks',
        createFallback: () => ({
          tasks: [] as readonly TeamTask[],
          kanbanState: { teamName, reviewers: [], tasks: {} } as KanbanState,
        }),
        warningText: 'Tasks failed to load',
        load: () =>
          readConsistentTaskSnapshot(this.kanbanManager, teamName, () =>
            this.readTasksForUiSnapshot(teamName)
          ),
      })
    );
    const [
      taskBoardStepResult,
      inboxNamesStepResult,
      metaMembersStepResult,
      teamMetaStepResult,
      launchStateStepResult,
    ] = await Promise.all([
      taskBoardStep,
      inboxNamesStep,
      metaMembersStep,
      teamMetaStep,
      launchStateStep,
    ]);

    // After parallelizing the top read phase, these marks no longer represent
    // serial stage boundaries. They now capture the actual completion time for
    // each async read relative to getTeamData() start, which keeps slow-log
    // diagnostics useful without mutating marks from concurrent branches.
    marks.tasks = taskBoardStepResult.completedAt;
    marks.inboxNames = inboxNamesStepResult.completedAt;
    marks.metaMembers = metaMembersStepResult.completedAt;
    marks.teamMeta = teamMetaStepResult.completedAt;
    marks.launchState = launchStateStepResult.completedAt;
    marks.kanbanState = taskBoardStepResult.completedAt;

    if (taskBoardStepResult.warning) warnings.push(taskBoardStepResult.warning);
    if (inboxNamesStepResult.warning) warnings.push(inboxNamesStepResult.warning);
    if (metaMembersStepResult.warning) warnings.push(metaMembersStepResult.warning);
    if (teamMetaStepResult.warning) warnings.push(teamMetaStepResult.warning);
    if (launchStateStepResult.warning) warnings.push(launchStateStepResult.warning);
    const tasks: readonly TeamTask[] = taskBoardStepResult.value.tasks;
    const inboxNames: string[] = inboxNamesStepResult.value;
    mark('postStart');

    const metaMembers: TeamConfig['members'] = metaMembersStepResult.value;
    const teamMeta: TeamMetaFile | null = teamMetaStepResult.value;
    const launchSnapshot = launchStateStepResult.value;
    const kanbanState: KanbanState = taskBoardStepResult.value.kanbanState;

    mark('kanbanGc');

    const tasksWithKanbanBase: TeamTaskWithKanban[] = tasks.map((task) =>
      this.taskProjection.attachKanbanCompatibility(task, kanbanState.tasks[task.id])
    );
    mark('attachKanban');

    const presenceIndex = await presenceIndexPromise;
    mark('loadPresenceIndex');

    const taskChangePresenceById = this.taskProjection.resolveTaskChangePresenceMap(
      tasksWithKanbanBase,
      changePresenceEnabled,
      presenceIndex,
      logSourceSnapshot
    );
    const tasksWithKanban: TeamTaskWithKanban[] = changePresenceEnabled
      ? tasksWithKanbanBase.map((task) => ({
          ...task,
          changePresence: taskChangePresenceById[task.id] ?? 'unknown',
        }))
      : tasksWithKanbanBase;
    mark('changePresence');

    const launchIdentity = teamMeta?.launchIdentity;
    const leadProviderBackendId = launchIdentity
      ? (migrateProviderBackendId(
          launchIdentity.providerId,
          launchIdentity.providerBackendId ?? teamMeta?.providerBackendId
        ) ?? undefined)
      : (migrateProviderBackendId(teamMeta?.providerId, teamMeta?.providerBackendId) ?? undefined);

    const members = this.memberResolver.resolveMembers(
      config,
      metaMembers,
      inboxNames,
      tasksWithKanban,
      {
        launchSnapshot,
        leadProviderId: launchIdentity?.providerId ?? teamMeta?.providerId,
        leadProviderBackendId,
        leadFastMode: teamMeta?.launchIdentity?.selectedFastMode ?? teamMeta?.fastMode ?? undefined,
        leadRuntimeSettings: resolveSyntheticLeadRuntimeSettings(teamMeta),
      }
    );
    await this.synthesizeLeadMemberIfMissing(teamName, config, members, tasksWithKanban, teamMeta);
    mark('resolveMembers');

    try {
      const runtimeAdvisories = await this.getMemberRuntimeAdvisoriesForSnapshot(
        teamName,
        members,
        this.getRuntimeAdvisoryObservedAfterMs(launchSnapshot)
      );
      for (const member of members) {
        const advisory = runtimeAdvisories.get(member.name);
        if (advisory) {
          member.runtimeAdvisory = advisory;
        }
      }
    } catch {
      warnings.push('Member runtime advisories failed to load');
    }
    mark('runtimeAdvisories');

    // Enrich members with git branch when it differs from lead's branch.
    // UI-first reads can skip this because the renderer hydrates branches through branch sync.
    if (includeMemberBranches) {
      await this.enrichMemberBranches(members, config);
    }
    mark('enrichBranches');
    mark('syncComments');

    const processes = await this.readProcesses(teamName);
    mark('processes');

    const totalMs = Date.now() - startedAt;
    if (totalMs >= 1500) {
      const counts = `counts=tasks:${tasks.length},inboxNames:${inboxNames.length},members:${members.length},processes:${processes.length}`;
      const branchMode = includeMemberBranches ? 'full' : 'skipped';
      logger.warn(
        `getTeamData team=${teamName} slow total=${totalMs}ms config=${msSince('config')} tasks=${msSince('tasks')} inboxNames=${msSince(
          'inboxNames'
        )} membersMeta=${msSince('metaMembers')} kanban=${msSince('kanbanState')} kanbanGc=${msSince(
          'kanbanGc'
        )} post=${msBetween('postStart', 'attachKanban')}/loadPresenceIndex=${msBetween(
          'attachKanban',
          'loadPresenceIndex'
        )}/changePresence=${msBetween(
          'loadPresenceIndex',
          'changePresence'
        )}/resolveMembers=${msBetween(
          'changePresence',
          'resolveMembers'
        )}/runtimeAdvisories=${msBetween(
          'resolveMembers',
          'runtimeAdvisories'
        )}/enrichBranches=${msBetween(
          'runtimeAdvisories',
          'enrichBranches'
        )}/processes=${msBetween('syncComments', 'processes')} branchMode=${branchMode} ${counts}${
          warnings.length > 0 ? ` warnings=${warnings.join('|')}` : ''
        }`
      );
    }

    // Auto-track teams with alive processes for periodic health checks
    const hasAlive = processes.some((p) => !p.stoppedAt);
    if (hasAlive) {
      this.processHealthTeams.add(teamName);
    } else {
      this.processHealthTeams.delete(teamName);
    }

    return {
      teamName,
      config,
      tasks: tasksWithKanban.map(compactTeamTaskForSnapshot),
      members,
      kanbanState,
      processes,
      isAlive: hasAlive,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Paginated message retrieval for the messages panel.
   * Uses cursor-based pagination by timestamp to handle live message insertion.
   */
  async getMessagesPage(
    teamName: string,
    options: {
      cursor?: string | null;
      limit: number;
      liveMessages?: InboxMessage[];
      groupChatId?: string;
    }
  ): Promise<MessagesPage> {
    return readTeamMessagesPage(
      { inboxReader: this.inboxReader, messageFeedService: this.messageFeedService },
      teamName,
      options
    );
  }

  async getMessageFeed(
    teamName: string
  ): Promise<{ teamName: string; feedRevision: string; messages: InboxMessage[] }> {
    return this.messageFeedService.getFeed(teamName);
  }

  async getMemberActivityMeta(teamName: string): Promise<TeamMemberActivityMeta> {
    return this.memberActivityMetaService.getMeta(teamName);
  }

  invalidateMessageFeed(teamName: string): void {
    this.messageFeedService.invalidate(teamName);
    this.memberActivityMetaService.invalidate(teamName);
  }

  /**
   * Enriches members with gitBranch when their cwd differs from the lead's.
   * Mutates members in-place for efficiency (called right after resolveMembers).
   */
  private async enrichMemberBranches(
    members: TeamViewSnapshot['members'],
    config: TeamConfig
  ): Promise<void> {
    const leadEntry = config.members?.find((member) => isLeadMember(member));
    const leadCwd = leadEntry?.cwd ?? config.projectPath;
    if (!leadCwd) return;

    const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let leadBranch: string | null = null;
    try {
      leadBranch = await withTimeout(gitIdentityResolver.getBranch(path.normalize(leadCwd)), 2000);
    } catch {
      return;
    }

    const candidates = members.filter((member) => member.cwd && member.cwd !== leadCwd);
    if (candidates.length === 0) return;

    const concurrency = process.platform === 'win32' ? 4 : 8;
    for (let index = 0; index < candidates.length; index += concurrency) {
      const batch = candidates.slice(index, index + concurrency);
      await Promise.all(
        batch.map(async (member) => {
          if (!member.cwd) return;
          try {
            const branch = await withTimeout(
              gitIdentityResolver.getBranch(path.normalize(member.cwd)),
              2000
            );
            if (branch && branch !== leadBranch) {
              member.gitBranch = branch;
            }
          } catch {
            // Member cwd may not be a git repo - skip silently.
          }
        })
      );
    }
  }

  startProcessHealthPolling(): void {
    if (this.processHealthTimer) return;
    this.processHealthTimer = setInterval(() => {
      void this.processHealthTick();
    }, PROCESS_HEALTH_INTERVAL_MS);
    // Background maintenance should not keep the process alive.
    this.processHealthTimer.unref();
  }

  stopProcessHealthPolling(): void {
    if (this.processHealthTimer) {
      clearInterval(this.processHealthTimer);
      this.processHealthTimer = null;
    }
    this.processHealthTeams.clear();
  }

  trackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.add(teamName);
  }

  untrackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.delete(teamName);
  }

  private async processHealthTick(): Promise<void> {
    // The interval does not wait for a slow tick, so a tick still running skips the next.
    if (this.processHealthTickInFlight) return;
    this.processHealthTickInFlight = true;
    try {
      for (const teamName of [...this.processHealthTeams]) {
        try {
          await this.readProcesses(teamName);
        } catch {
          // best-effort per team
        }
      }
    } finally {
      this.processHealthTickInFlight = false;
    }
  }

  /**
   * Native lifecycle queries own agent process identity, including adoption
   * after restart. No processes.json fallback can override that authority.
   */
  private async readProcesses(teamName: string): Promise<TeamProcess[]> {
    const snapshot = await this.runtimeSnapshot(teamName);
    return Object.values(snapshot.members).flatMap((member): TeamProcess[] => {
      const pid = member.runtimePid ?? member.pid;
      if (!member.alive || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return [];
      return [
        {
          id: `${snapshot.runId ?? teamName}:${member.memberName}`,
          label: member.memberName,
          pid,
          registeredBy: member.memberName,
          registeredAt: member.updatedAt,
          ...(member.processCommand ? { command: member.processCommand } : {}),
        },
      ];
    });
  }

  /**
   * Kill a registered CLI process by PID (SIGTERM) and mark it as stopped in processes.json.
   */
  async killProcess(teamName: string, pid: number): Promise<void> {
    // Try to kill the process (cross-platform: SIGTERM on Unix, taskkill on Windows)
    try {
      killProcessByPid(pid);
    } catch (err: unknown) {
      // ESRCH = process not found — still mark as stopped below
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code !== 'ESRCH'
      ) {
        throw new Error(`Failed to kill process ${pid}: ${(err as Error).message}`);
      }
    }

    try {
      this.getController(teamName).processes.stopProcess({ pid });
    } catch {
      // Ignore missing persisted registry rows after OS-level stop.
    }
  }

  /**
   * Ensures a member exists in members.meta.json.
   * Members can appear in the UI from three sources (see TeamMemberResolver):
   *   1. members.meta.json
   *   2. config.json members array (CLI-created)
   *   3. inbox file presence (CLI-spawned teammates)
   * If the member exists in source 2 or 3 but not in meta, migrates it so
   * that edit/delete operations work.
   */
  private async ensureMemberInMeta(
    teamName: string,
    memberName: string
  ): Promise<{ members: TeamMember[]; member: TeamMember }> {
    let members = await this.membersMetaStore.getMembers(teamName);
    const config = await this.configReader.getConfig(teamName);
    const inboxNames = await this.inboxReader.listInboxNames(teamName);
    const knownNames = new Set(members.map((member) => member.name.trim().toLowerCase()));
    const migratedMembers: TeamMember[] = [];
    const joinedAt = Date.now();

    for (const configMember of config?.members ?? []) {
      const name = typeof configMember?.name === 'string' ? configMember.name.trim() : '';
      const normalizedName = name.toLowerCase();
      if (
        !name ||
        normalizedName === 'user' ||
        isLeadMember(configMember) ||
        knownNames.has(normalizedName)
      ) {
        continue;
      }
      const providerId = normalizeOptionalTeamProviderId(configMember.providerId);
      migratedMembers.push({
        name,
        role: configMember.role,
        workflow: configMember.workflow,
        isolation: configMember.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId,
        providerBackendId: migrateProviderBackendId(providerId, configMember.providerBackendId),
        model: configMember.model,
        effort: isTeamEffortLevel(configMember.effort) ? configMember.effort : undefined,
        fastMode: configMember.fastMode,
        mcpPolicy: normalizeTeamMemberMcpPolicy(configMember.mcpPolicy),
        agentType: configMember.agentType ?? 'general-purpose',
        color: configMember.color,
        joinedAt: configMember.joinedAt ?? joinedAt,
        agentId: configMember.agentId,
        cwd: configMember.cwd,
      });
      knownNames.add(normalizedName);
    }

    const rosterNames = [
      ...members.map((member) => member.name),
      ...migratedMembers.map((member) => member.name),
      ...inboxNames.map((name) => name.trim()).filter(Boolean),
    ];
    const keepAutoSuffix = createCliAutoSuffixNameGuard(rosterNames);
    const keepProvisioner = createCliProvisionerNameGuard(rosterNames);
    const explicitNames = new Set(knownNames);
    for (const inboxName of inboxNames) {
      const name = inboxName.trim();
      const normalizedName = name.toLowerCase();
      if (
        !name ||
        normalizedName === 'user' ||
        isLeadMember({ name, agentType: undefined }) ||
        knownNames.has(normalizedName) ||
        !isMaterializableInboxMemberName(name, explicitNames) ||
        !keepAutoSuffix(name) ||
        !keepProvisioner(name)
      ) {
        continue;
      }
      migratedMembers.push({ name, agentType: 'general-purpose', joinedAt });
      knownNames.add(normalizedName);
    }

    if (migratedMembers.length > 0) {
      const nextMembers = applyDistinctRosterColors([...members, ...migratedMembers]);
      await this.membersMetaStore.writeMembers(teamName, nextMembers);
      members = nextMembers;
    }

    const normalizedMemberName = memberName.trim().toLowerCase();
    const member = members.find(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedMemberName
    );
    if (!member) {
      throw new Error(`Member "${memberName}" not found`);
    }

    return { members, member };
  }

  async addMember(teamName: string, request: AddMemberRequest): Promise<void> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Member name cannot be empty');
    }
    const formatError = validateTeamMemberNameFormat(name);
    if (formatError) {
      throw new Error(`Member name "${name}" is invalid: ${formatError}`);
    }
    if (name.toLowerCase() === 'user') {
      throw new Error('Member name "user" is reserved');
    }
    const suffixInfo = parseNumericSuffixName(name);
    if (suffixInfo && suffixInfo.suffix >= 2) {
      throw new Error(
        `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
      );
    }

    const members = await this.membersMetaStore.getMembers(teamName);
    const existing = members.find((m) => m.name.toLowerCase() === name.toLowerCase());

    if (existing) {
      if (existing.removedAt) {
        throw new Error(`Name "${name}" was previously used by a removed member`);
      }
      throw new Error(`Member "${name}" already exists`);
    }

    const memberProviderId = normalizeOptionalTeamProviderId(request.providerId);
    const memberProviderBackendId = memberProviderId
      ? migrateProviderBackendId(memberProviderId, request.providerBackendId)
      : request.providerBackendId;
    const newMember: TeamMember = {
      name,
      role: request.role?.trim() || undefined,
      workflow: request.workflow?.trim() || undefined,
      isolation: request.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: memberProviderId,
      ...(memberProviderBackendId ? { providerBackendId: memberProviderBackendId } : {}),
      model: request.model?.trim() || undefined,
      effort: isTeamEffortLevel(request.effort) ? request.effort : undefined,
      ...(request.fastMode === 'inherit' || request.fastMode === 'on' || request.fastMode === 'off'
        ? { fastMode: request.fastMode }
        : {}),
      mcpPolicy: normalizeTeamMemberMcpPolicy(request.mcpPolicy),
      agentType: 'general-purpose',
      joinedAt: Date.now(),
    };

    await this.assertRosterMutationAllowed(
      teamName,
      toProvisioningMemberShape([...members, newMember])
    );
    const nextMembers = applyDistinctRosterColors([...members, newMember]);
    await this.membersMetaStore.writeMembers(teamName, nextMembers);
  }

  async updateMemberRole(
    teamName: string,
    memberName: string,
    newRole: string | undefined
  ): Promise<{ oldRole: string | undefined; changed: boolean }> {
    const { members, member } = await this.ensureMemberInMeta(teamName, memberName);
    if (member.removedAt) throw new Error(`Member "${memberName}" is removed`);
    if (isLeadMember(member)) throw new Error('Cannot change team lead role');

    const oldRole = member.role;
    const normalized = typeof newRole === 'string' && newRole.trim() ? newRole.trim() : undefined;
    if (oldRole === normalized) return { oldRole, changed: false };

    member.role = normalized;
    await this.membersMetaStore.writeMembers(teamName, members);
    return { oldRole, changed: true };
  }

  async replaceMembers(teamName: string, request: ReplaceMembersRequest): Promise<void> {
    return this.runConfigurationOperation(teamName, () =>
      this.replaceMembersUnlocked(teamName, request)
    );
  }

  private async replaceMembersUnlocked(
    teamName: string,
    request: ReplaceMembersRequest
  ): Promise<void> {
    const existingMeta = await this.membersMetaStore.getMeta(teamName);
    const existing = existingMeta?.members ?? [];
    const existingLead = existing.find(isLeadMember) ?? null;
    const existingByName = new Map(existing.map((m) => [m.name.toLowerCase(), m]));
    const joinedAt = Date.now();
    const nextByName = new Set<string>();

    const nextActive = applyDistinctRosterColors(
      request.members.map((member) => {
        const name = member.name.trim();
        if (!name) throw new Error('Member name cannot be empty');
        const formatError = validateTeamMemberNameFormat(name);
        if (formatError) {
          throw new Error(`Member name "${name}" is invalid: ${formatError}`);
        }
        if (name.toLowerCase() === 'user') {
          throw new Error('Member name "user" is reserved');
        }
        if (name.toLowerCase() === 'team-lead') {
          throw new Error('Member name "team-lead" is reserved');
        }
        if (nextByName.has(name.toLowerCase())) {
          throw new Error(`Member "${name}" already exists`);
        }
        const suffixInfo = parseNumericSuffixName(name);
        if (suffixInfo && suffixInfo.suffix >= 2) {
          throw new Error(
            `Member name "${name}" is not allowed (reserved for runtime-managed numeric suffixes). Use "${suffixInfo.base}" instead.`
          );
        }
        nextByName.add(name.toLowerCase());
        const prev = existingByName.get(name.toLowerCase());
        const isSameActiveMember = Boolean(prev && prev.removedAt == null);
        const providerId = normalizeOptionalTeamProviderId(member.providerId);
        const providerBackendId = providerId
          ? migrateProviderBackendId(providerId, member.providerBackendId)
          : member.providerBackendId;
        return {
          name,
          role: member.role?.trim() || undefined,
          workflow: member.workflow?.trim() || undefined,
          isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId,
          providerBackendId,
          model: member.model?.trim() || undefined,
          effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
          fastMode:
            member.fastMode === 'inherit' || member.fastMode === 'on' || member.fastMode === 'off'
              ? member.fastMode
              : undefined,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
          cwd: isSameActiveMember ? prev?.cwd : undefined,
          agentType: prev?.agentType ?? 'general-purpose',
          agentId: isSameActiveMember ? prev?.agentId : undefined,
          color: prev?.color,
          joinedAt: prev?.joinedAt ?? joinedAt,
          removedAt: undefined,
        };
      })
    );
    await this.assertRosterMutationAllowed(teamName, toProvisioningMemberShape(nextActive));

    // Preserve/mark removed members so stale inbox files don't resurrect them in the UI.
    const nextRemoved: TeamMember[] = [];
    for (const prev of existing) {
      if (isLeadMember(prev)) continue;
      const prevName = prev.name.trim();
      if (!prevName) continue;
      const key = prevName.toLowerCase();
      if (nextByName.has(key)) continue;
      nextRemoved.push({
        ...prev,
        removedAt: prev.removedAt ?? joinedAt,
      });
    }

    const out: TeamMember[] = [...nextActive, ...nextRemoved];
    if (existingLead) {
      const leadKey = existingLead.name.trim().toLowerCase();
      if (!out.some((m) => m.name.trim().toLowerCase() === leadKey)) {
        out.unshift({ ...existingLead, removedAt: undefined });
      }
    }
    await this.membersMetaStore.writeMembers(teamName, out, {
      providerBackendId: existingMeta?.providerBackendId,
    });
  }

  async removeMember(teamName: string, memberName: string): Promise<void> {
    const { members, member } = await this.ensureMemberInMeta(teamName, memberName);

    // Removal is intentionally idempotent. The tombstone is already the durable
    // success state, so retries after an IPC timeout or service restart are safe.
    if (member.removedAt) return;
    if (isLeadMember(member)) {
      throw new Error('Cannot remove team lead');
    }

    await this.assertRosterMutationAllowed(
      teamName,
      toProvisioningMemberShape(
        members.filter(
          (candidate) => candidate.name.trim().toLowerCase() !== memberName.trim().toLowerCase()
        )
      )
    );
    member.removedAt = Date.now();
    await this.membersMetaStore.writeMembers(teamName, members);
  }

  async restoreMember(teamName: string, memberName: string): Promise<TeamMember> {
    const [members, config] = await Promise.all([
      this.membersMetaStore.getMembers(teamName),
      this.configReader.getConfig(teamName),
    ]);
    const plan = planTeamMemberRestore({ memberName, members, config });
    const nextMembers = applyDistinctRosterColors(plan.nextMembers);

    await this.assertRosterMutationAllowed(teamName, toProvisioningMemberShape(nextMembers));

    this.membersMetaStore.serializeMembers(nextMembers);

    const persistConfig = async (): Promise<void> => {
      if (!plan.nextConfig) return;
      const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
      await atomicWriteAsync(configPath, JSON.stringify(plan.nextConfig, null, 2));
      await TeamConfigReader.primeConfig(teamName, plan.nextConfig);
    };
    if (plan.persistMetadataFirst) await this.membersMetaStore.writeMembers(teamName, nextMembers);
    await persistConfig();
    if (!plan.persistMetadataFirst) await this.membersMetaStore.writeMembers(teamName, nextMembers);
    return (
      nextMembers.find(
        (candidate) => candidate.name.trim().toLowerCase() === plan.normalizedMemberName
      ) ?? plan.restoredMember
    );
  }

  async createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask> {
    return (await this.createTaskWithOutcome(teamName, request)).task;
  }

  async createTaskWithOutcome(
    teamName: string,
    request: CreateTaskRequest & { status?: TeamTaskStatus; actor?: string },
    executionPatch?: ExecutionTaskPatch
  ): Promise<{ task: TeamTask; outcome: 'APPLIED' | 'REPLAY' }> {
    const authority = await this.registryTasks.readRegistryTaskAuthority(teamName);
    const hasSpecProject = Object.hasOwn(request, 'specProject');
    const hasSpecSlug = Object.hasOwn(request, 'specSlug');
    const hasRequirements = Object.hasOwn(request, 'requirements');
    const hasAnyRegistryFields = hasSpecProject || hasSpecSlug || hasRequirements;
    let binding: TeamSpecBinding | undefined;
    if (hasAnyRegistryFields) {
      if (
        !hasSpecProject ||
        !hasSpecSlug ||
        !hasRequirements ||
        typeof request.specProject !== 'string' ||
        typeof request.specSlug !== 'string' ||
        !Array.isArray(request.requirements)
      ) {
        throw new RegistryTaskProviderError({
          code: 'REGISTRY_SCOPE_INCOMPLETE',
          teamName,
          message:
            `Task creation for team "${teamName}" needs specProject, specSlug and requirements together. ` +
            'Read the bound specification first (team_spec_spec_entities with kinds ["requirement"]) and pass ids that exist there, ' +
            'for example specProject "owner/project", specSlug "spec-slug", requirements ["FR-1"]. ' +
            'A task without a requirement is refused because it cannot be traced in the corpus.',
        });
      }
      binding = validateSpecBinding(
        { project: request.specProject, spec: request.specSlug },
        teamName
      );
    }
    if (!authority.config || (!authority.backed && !binding)) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `The task binding for team "${teamName}" could not be verified.`,
      });
    }
    if (binding && !authority.backed) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName,
        project: binding.project,
        spec: binding.spec,
        message: `Team "${teamName}" is not linked to registry scope "${binding.project}/${binding.spec}"; no local task was created.`,
      });
    }

    if (!binding) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message:
          `Team "${teamName}" is bound to a registry scope, so a task must name it: pass specProject, specSlug and requirements. ` +
          'Use the bound pair and requirement ids that exist in that corpus; the task then lands in TASKS.md automatically.',
      });
    }
    if (
      !authority.bindings.some(
        (candidate) => candidate.project === binding.project && candidate.spec === binding.spec
      )
    ) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName,
        project: binding.project,
        spec: binding.spec,
        message: `Registry scope "${binding.project}/${binding.spec}" is not linked to team "${teamName}".`,
      });
    }
    const groupChatId = executionPatch?.groupChatId ?? request.groupChatId;
    const registryWriter = await this.registryTasks.resolveRegistryTeamTaskWriter(
      teamName,
      binding
    );
    const created = await registryWriter.createTask(
      {
        subject: request.subject,
        description: request.description,
        requirements: request.requirements ?? [],
        tracking: request.tracking,
        owner: request.owner,
        blockedBy: request.blockedBy,
        related: request.related,
        startImmediately: request.startImmediately === true,
        status: request.status,
        actor: request.actor,
        executionPatch: {
          ...executionPatch,
          ...(request.creationCommand ? { creationCommand: request.creationCommand } : {}),
        },
        commandId: request.command?.commandId ?? request.creationCommand?.commandId,
        groupChatId: request.groupChatId,
        descriptionTaskRefs: request.descriptionTaskRefs,
        prompt: request.prompt,
        promptTaskRefs: request.promptTaskRefs,
        projectPath: await this.readTaskCreateProjectPath(teamName),
        commandIdempotencyKey:
          request.command?.idempotencyKey ?? request.creationCommand?.commandId,
      },
      groupChatId !== undefined && groupChatId !== null
        ? () =>
            assertTaskGroupChatAssociation(
              teamName,
              groupChatId,
              undefined,
              this.taskGroupChatCatalog
            )
        : undefined
    );
    const { task, createdInAttempt } = created;
    this.invalidateGlobalTaskProjectionCache(teamName);
    await this.notifyTaskStartBestEffort(teamName, task, request);
    return { task, outcome: createdInAttempt ? 'APPLIED' : 'REPLAY' };
  }

  private async notifyTaskStartBestEffort(
    teamName: string,
    task: TeamTask,
    request: CreateTaskRequest
  ): Promise<void> {
    if (task.status !== 'in_progress' || !task.owner) return;
    try {
      const leadName = await this.resolveLeadName(teamName);
      if (this.isLeadOwner(task.owner, leadName)) {
        if (request.command) {
          await this.sendDurableUserTaskStartNotification(teamName, task, leadName);
        } else {
          await this.sendUserTaskStartNotification(teamName, task);
        }
      }
    } catch {
      if (request.command) {
        logger.warn(
          `[TeamDataService] category=post_commit_notification code=task_start_notification_failed team=${toSafeDiagnosticIdentifier(teamName)} task=${toSafeDiagnosticIdentifier(task.id)}`
        );
      }
    }
  }

  private async readTaskCreateProjectPath(teamName: string): Promise<string | undefined> {
    try {
      const config = await readConfigForUiSnapshot(this.configReader, teamName);
      return config?.projectPath;
    } catch {
      return undefined;
    }
  }

  async startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    const { task, writer } = registry;
    if (task.status !== 'pending') {
      throw new Error(`Task #${taskId} is not pending (current: ${task.status})`);
    }
    await writer.replaceStatus({
      taskId,
      to: 'in_progress',
      actor: 'user',
      expectedStatus: 'pending',
    });
    this.invalidateGlobalTaskProjectionCache(teamName);
    if (task.owner) {
      try {
        const leadName = await this.resolveLeadName(teamName);
        if (!this.isLeadOwner(task.owner, leadName)) {
          const parts = [
            `**start working on task now** ${this.getTaskLabel(task)} "${task.subject}"`,
          ];
          if (task.description?.trim()) parts.push(`\nDetails:\n${task.description.trim()}`);
          parts.push(
            '',
            wrapAgentBlock(
              [
                'Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.',
                'Update task status using the board MCP tools:',
                `task_complete { teamName: "${teamName}", taskId: "${task.id}", actor: "${task.owner}" }`,
              ].join('\n')
            )
          );
          await this.sendMessage(teamName, {
            member: task.owner,
            from: leadName,
            text: parts.join('\n'),
            taskRefs: task.descriptionTaskRefs,
            summary: `Start working on ${this.getTaskLabel(task)}`,
            source: 'system_notification',
          });
        }
      } catch {
        // Best-effort notification
      }
    }
    return { notifiedOwner: !!task.owner };
  }

  /**
   * Start a task triggered by the user via UI.
   * Unlike startTask(), this always notifies the owner (including the lead in solo teams).
   */
  async startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    const { task, writer } = registry;
    if (task.status !== 'pending') {
      throw new Error(`Task #${taskId} is not pending (current: ${task.status})`);
    }
    await writer.replaceStatus({
      taskId,
      to: 'in_progress',
      actor: 'user',
      expectedStatus: 'pending',
    });
    this.invalidateGlobalTaskProjectionCache(teamName);
    if (task.owner) await this.sendUserTaskStartNotification(teamName, task);
    return { notifiedOwner: !!task.owner };
  }

  /**
   * Send a task start notification from the user to the task owner.
   * Includes description, prompt, and task_get/task_complete instructions.
   * Used by startTaskByUser and createTask (startImmediately).
   */
  private async sendUserTaskStartNotification(teamName: string, task: TeamTask): Promise<void> {
    if (!task.owner) return;
    try {
      await this.sendMessage(teamName, this.buildUserTaskStartNotification(teamName, task));
    } catch {
      // Best-effort notification
    }
  }

  private async sendDurableUserTaskStartNotification(
    teamName: string,
    task: TeamTask,
    leadName: string
  ): Promise<void> {
    await this.sendRuntimeRecipientMessage(teamName, {
      ...this.buildUserTaskStartNotification(teamName, task),
      member: leadName,
      messageId: `task-start:${teamName}:${task.id}`,
    });
  }

  private buildUserTaskStartNotification(teamName: string, task: TeamTask): SendMessageRequest {
    const parts = [`**start working on task now** ${this.getTaskLabel(task)} "${task.subject}"`];
    if (task.description?.trim()) {
      parts.push(`\nDetails:\n${task.description.trim()}`);
    }
    if (task.prompt?.trim()) {
      parts.push(`\nInstructions:\n${task.prompt.trim()}`);
    }
    parts.push(
      '',
      wrapAgentBlock(
        [
          `This start notification can become stale after reassignment or completion. Before modifying anything, fetch the current task and verify that task.owner is your configured teammate name and task.status is pending or in_progress. If the owner changed or the task is completed/deleted, do not start or reopen it, modify files, add a completion comment, or complete it; stop unless the current owner explicitly asks you to collaborate on fresh follow-up work.`,
          `Begin work on this task immediately. Keep it moving until it is completed or clearly blocked. Do not leave it idle.`,
          `To fetch the full task context (description, comments, attachments) use:`,
          `task_get { teamName: "${teamName}", taskId: "${task.id}" }`,
          `When done, update task status:`,
          `task_complete { teamName: "${teamName}", taskId: "${task.id}", actor: "${task.owner}" }`,
        ].join('\n')
      )
    );
    return {
      member: task.owner!,
      from: 'user',
      text: parts.join('\n'),
      taskRefs: task.descriptionTaskRefs,
      summary: `Start working on ${this.getTaskLabel(task)}`,
      source: 'system_notification',
    };
  }

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string,
    binding?: RegistryTaskScope
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    if (status === 'completed') {
      await this.withTaskAttestationJournal(teamName, taskId, registry, (current) =>
        this.updateTaskStatusWithReceiptCore(teamName, taskId, status, actor, undefined, current)
      );
    } else {
      await this.withTaskAttestationJournal(teamName, taskId, registry, async (current) => {
        await current.writer.replaceStatus({ taskId, to: status, actor });
      });
    }
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async updateTaskStatusWithReceipt(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string,
    expectedStatus?: TeamTaskStatus,
    binding?: RegistryTaskScope
  ): Promise<readonly RegistryTaskTransition[]> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    return this.withTaskAttestationJournal(teamName, taskId, registry, (current) =>
      this.updateTaskStatusWithReceiptCore(teamName, taskId, status, actor, expectedStatus, current)
    );
  }

  private async updateTaskStatusWithReceiptCore(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor: string | undefined,
    expectedStatus: TeamTaskStatus | undefined,
    registry: RegistryTaskWriteTarget
  ): Promise<readonly RegistryTaskTransition[]> {
    const { task, writer } = registry;
    if (expectedStatus !== undefined && task.status !== expectedStatus) {
      throw new RegistryTeamTaskWriteError(
        'STATUS_CONFLICT',
        `Task "${taskId}" changed status; re-read it before retrying.`,
        { taskId, details: { currentStatus: task.status, expectedStatus } }
      );
    }
    if (status !== 'completed') {
      const result = await writer.replaceStatus({ taskId, to: status, actor, expectedStatus });
      this.invalidateGlobalTaskProjectionCache(teamName);
      return result.transitions;
    }
    if (task.status === 'completed') return [];
    if (task.status === 'deleted') {
      throw new RegistryTeamTaskWriteError(
        'STATUS_CONFLICT',
        `Task "${taskId}" is deleted; restore it before completing it.`,
        { taskId, details: { currentStatus: task.status, expectedStatus } }
      );
    }
    if (task.artifactRequirement?.required === true) {
      const requirement = task.artifactRequirement;
      const proof = requirement.proof;
      const attachments = (task.attachments ?? []).filter(
        (attachment) => attachment.id === proof?.attachmentId
      );
      if (!proof || attachments.length !== 1 || !attachments[0]) {
        throw new RegistryTeamTaskWriteError(
          'REGISTRY_REFUSED',
          'A required local task artifact is missing or has invalid metadata.',
          { taskId }
        );
      }
      try {
        await verifyLocalTaskArtifact({
          attachment: attachments[0],
          attachmentProof: proof,
          allowedRoot: taskArtifactRoot(getAppDataPath(), teamName, task.id),
          expectedFilename: requirement.expectedFilename,
        });
      } catch {
        throw new RegistryTeamTaskWriteError(
          'REGISTRY_REFUSED',
          'The required local task artifact cannot be verified.',
          { taskId }
        );
      }
    }
    const result = await writer.replaceStatus({
      taskId,
      to: status,
      actor,
      expectedStatus: expectedStatus ?? task.status,
    });
    this.invalidateGlobalTaskProjectionCache(teamName);
    return result.transitions;
  }

  private taskSecurityOutcomeUnknown(taskId: string): RegistryTeamTaskWriteError {
    return new RegistryTeamTaskWriteError(
      'TASK_SECURITY_OUTCOME_UNKNOWN',
      'The registry task outcome is unknown; the pending journal entry must be reconciled first.',
      { taskId }
    );
  }

  private async withTaskAttestationJournal<T>(
    teamName: string,
    taskId: string,
    initial: RegistryTaskWriteTarget,
    operation: (registry: RegistryTaskWriteTarget) => Promise<T>
  ): Promise<T> {
    let enteredOperation = false;
    try {
      return await this.taskAttestationJournal.run(teamName, async (entries) => {
        enteredOperation = true;
        const registry = await this.registryTasks.readRegistryTaskForWrite(
          teamName,
          taskId,
          initial.writer.binding
        );
        if (
          registry.teamId !== initial.teamId ||
          registry.task.id !== initial.task.id ||
          registry.task.registryTask?.localId !== initial.task.registryTask?.localId
        ) {
          throw new RegistryTaskProviderError({
            code: 'REGISTRY_SCOPE_INCOMPLETE',
            teamName,
            message: `Task "${taskId}" registry authority changed before the operation.`,
          });
        }
        const identities = new Set([taskId, registry.task.id, registry.task.registryTask?.localId]);
        if (
          entries.some(
            (entry) => identities.has(entry.taskId) || identities.has(entry.replay.taskId)
          )
        ) {
          throw this.taskSecurityOutcomeUnknown(taskId);
        }
        return operation(registry);
      });
    } catch (error) {
      if (!enteredOperation) throw this.taskSecurityOutcomeUnknown(taskId);
      throw error;
    }
  }

  /**
   * Called when a task file changes on disk (e.g. teammate CLI wrote it).
   * If the latest historyEvents entry shows a non-user actor started the task,
   * sends an inbox notification to the team lead.
   */
  async notifyLeadOnTeammateTaskStart(teamName: string, taskId: string): Promise<void> {
    try {
      const tasks = await this.getTasks(teamName);
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      const events = task.historyEvents;
      if (!Array.isArray(events) || events.length === 0) return;

      const last = events[events.length - 1];
      if (last.type !== 'status_changed' || last.to !== 'in_progress') return;
      if (!last.actor || last.actor === 'user') return;
      if (!(await this.isTeamManagedByThisProfile(teamName))) return;

      // Dedup: only notify once per unique transition (keyed by team+task+timestamp).
      const dedupKey = `${teamName}:${taskId}:${last.timestamp}`;
      if (this.notifiedTaskStarts.has(dedupKey)) return;
      this.notifiedTaskStarts.add(dedupKey);
      // Prevent unbounded growth in long-running sessions.
      if (this.notifiedTaskStarts.size > 500) {
        const first = this.notifiedTaskStarts.values().next().value!;
        this.notifiedTaskStarts.delete(first);
      }

      const leadName = await this.resolveLeadName(teamName);
      if (this.isLeadOwner(last.actor, leadName)) return;

      await this.sendMessage(teamName, {
        member: leadName,
        from: last.actor,
        text: `@${last.actor} **started task** ${this.getTaskLabel(task)} "${task.subject}"`,
        summary: `Task ${this.getTaskLabel(task)} started`,
        source: 'system_notification',
      });
    } catch (error) {
      logger.warn(`[TeamDataService] notifyLeadOnTeammateTaskStart failed: ${String(error)}`);
    }
  }

  async notifyLeadOnTeammateTaskComment(teamName: string, taskId: string): Promise<void> {
    await this.taskEvents.notifyLeadOnTeammateTaskComment(teamName, taskId);
  }

  async initializeTaskCommentNotificationState(): Promise<void> {
    await this.taskEvents.initializeTaskCommentNotificationState();
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    await registry.writer.replaceStatus({ taskId, to: 'deleted', actor: 'user' });
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    await registry.writer.replaceStatus({
      taskId,
      to: 'pending',
      actor: 'user',
      expectedStatus: 'deleted',
    });
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async getDeletedTasks(teamName: string, binding?: RegistryTaskScope): Promise<TeamTask[]> {
    const tasks = await this.readBoardSnapshot(teamName, { binding, includeDeleted: true });
    return tasks.filter((task) => task.status === 'deleted');
  }

  async updateTaskOwner(
    teamName: string,
    taskId: string,
    owner: string | null,
    actor = 'user',
    binding?: RegistryTaskScope
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    await registry.writer.replaceOwner({ taskId, owner, actor });
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async readTaskArtifactData(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<string | null> {
    await this.requireRegistryTaskScope(teamName);
    if (!TASK_ARTIFACT_UUID.test(attachmentId)) return null;
    const { task } = await this.registryTaskProvider.getTask(teamName, taskId);
    if (!task) return null;
    const matchingAttachments = (task.attachments ?? []).filter(
      (attachment) => attachment.id === attachmentId
    );
    if (matchingAttachments.length !== 1) return null;
    const [attachment] = matchingAttachments;
    if (!attachment) return null;
    const base64 = await this.taskAttachmentStore.getAttachment(
      teamName,
      task.id,
      attachment.id,
      attachment.mimeType
    );
    if (base64 === null) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.length !== attachment.size) return null;
    const proof = task.artifactRequirement?.proof;
    if (proof?.attachmentId === attachment.id) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (proof.size !== bytes.length || proof.sha256 !== sha256) return null;
    }
    return base64;
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: TaskFieldUpdates,
    binding?: RegistryTaskScope
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    return this.withTaskAttestationJournal(teamName, taskId, registry, (current) =>
      this.updateTaskFieldsCore(teamName, taskId, fields, current)
    );
  }

  private async updateTaskFieldsCore(
    teamName: string,
    taskId: string,
    fields: TaskFieldUpdates,
    registry: RegistryTaskWriteTarget
  ): Promise<void> {
    if (fields.groupChatId !== undefined && fields.groupChatId !== null) {
      await assertTaskGroupChatAssociation(
        teamName,
        fields.groupChatId,
        registry.task.groupChatId,
        this.taskGroupChatCatalog
      );
    }
    const decodedArtifact =
      fields.artifactFile === undefined ? undefined : decodeTaskArtifactFile(fields.artifactFile);

    const executionPatch: ExecutionTaskPatch = {};
    if (fields.groupChatId !== undefined) executionPatch.groupChatId = fields.groupChatId;
    const previousRequirement = registry.task.artifactRequirement;
    if (
      registry.task.status === 'completed' &&
      ((fields.artifactRequired === true && !previousRequirement?.required) ||
        fields.artifactExpectedFilename !== undefined ||
        fields.artifactFile !== undefined)
    ) {
      throw new Error('Reopen the completed task before changing its artifact');
    }
    if (fields.artifactExpectedFilename !== undefined) {
      const filename = fields.artifactExpectedFilename;
      if (
        typeof filename !== 'string' ||
        !filename.trim() ||
        filename.length > 255 ||
        /[\\/:\x00-\x1f\x7f]/u.test(filename) ||
        filename.trim() === '.' ||
        filename.trim() === '..'
      ) {
        throw new Error('Artifact name must be a filename without a directory');
      }
    }
    const required = fields.artifactRequired ?? previousRequirement?.required ?? false;
    const expectedFilename =
      fields.artifactExpectedFilename?.trim() ?? previousRequirement?.expectedFilename;
    if ((fields.artifactExpectedFilename !== undefined || decodedArtifact) && !required) {
      throw new Error(
        'Enable the artifact requirement before setting its name or attaching a file'
      );
    }
    if (decodedArtifact && expectedFilename && expectedFilename !== decodedArtifact.filename) {
      throw new Error(`Required artifact filename is ${expectedFilename}`);
    }
    let attachmentProof: TaskArtifactProof | undefined;
    if (decodedArtifact !== undefined) {
      const sha256 = createHash('sha256').update(decodedArtifact.data).digest('hex');
      const previousProof = previousRequirement?.proof;
      const previousAttachment = previousProof
        ? registry.task.attachments?.find(
            (attachment) => attachment.id === previousProof.attachmentId
          )
        : undefined;
      let reusePreviousAttachment = false;
      if (
        previousProof?.sha256 === sha256 &&
        previousProof.size === decodedArtifact.data.length &&
        previousAttachment?.filename === decodedArtifact.filename
      ) {
        const existingBase64 = await this.taskAttachmentStore.getAttachment(
          teamName,
          registry.task.id,
          previousAttachment.id,
          previousAttachment.mimeType
        );
        if (existingBase64 !== null) {
          const existingBytes = Buffer.from(existingBase64, 'base64');
          reusePreviousAttachment =
            existingBytes.toString('base64') === existingBase64 &&
            existingBytes.length === decodedArtifact.data.length &&
            createHash('sha256').update(existingBytes).digest('hex') === sha256;
        }
      }
      if (reusePreviousAttachment && previousProof) {
        attachmentProof = previousProof;
      } else {
        const attachmentId = randomUUID();
        const root = taskArtifactRoot(getAppDataPath(), teamName, registry.task.id);
        const storedAttachmentMeta = await this.taskAttachmentStore.saveAttachmentBuffer(
          teamName,
          registry.task.id,
          attachmentId,
          'artifact.bin',
          'application/octet-stream',
          decodedArtifact.data
        );
        const attachmentMeta: TaskAttachmentMeta = {
          ...storedAttachmentMeta,
          filename: decodedArtifact.filename,
        };
        const filePath = attachmentMeta.filePath;
        const relativeFile =
          typeof filePath === 'string' ? path.relative(root, path.resolve(filePath)) : '';
        if (
          !filePath ||
          !path.isAbsolute(filePath) ||
          !relativeFile ||
          relativeFile === '..' ||
          relativeFile.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeFile)
        ) {
          throw new Error('Task artifact storage is unavailable');
        }
        const fileStat = await fs.promises.lstat(filePath);
        if (
          fileStat.isSymbolicLink() ||
          !fileStat.isFile() ||
          fileStat.size !== decodedArtifact.data.length
        ) {
          throw new Error('Task artifact storage is unavailable');
        }
        attachmentProof = {
          attachmentId,
          sha256,
          size: decodedArtifact.data.length,
        };
        executionPatch.attachments = [...(registry.task.attachments ?? []), attachmentMeta];
      }
    }

    const policyIntent =
      fields.artifactRequired !== undefined ||
      fields.artifactExpectedFilename !== undefined ||
      attachmentProof !== undefined;
    let targetRequirement: TaskArtifactRequirementPatch | undefined;
    if (policyIntent) {
      const nameChanged =
        fields.artifactExpectedFilename !== undefined &&
        expectedFilename !== previousRequirement?.expectedFilename;
      targetRequirement = {
        required,
        ...(required && (expectedFilename ?? decodedArtifact?.filename) !== undefined
          ? { expectedFilename: expectedFilename ?? decodedArtifact?.filename }
          : {}),
        ...(required && attachmentProof
          ? { proof: attachmentProof }
          : required && !nameChanged && previousRequirement?.proof
            ? { proof: previousRequirement.proof }
            : {}),
      };
    }

    await registry.writer.updateCanonicalFields({
      taskId,
      subject: fields.subject,
      description: fields.description,
      requirements: fields.requirements,
    });
    if (targetRequirement) executionPatch.artifactRequirement = targetRequirement;
    if (Object.keys(executionPatch).length > 0) {
      await registry.writer.applyExecutionPatch(taskId, executionPatch);
    }
    this.invalidateGlobalTaskProjectionCache(teamName);
  }
  async applyTaskExecutionPatch(
    teamName: string,
    taskId: string,
    patch: ExecutionTaskPatch,
    binding?: RegistryTaskScope
  ): Promise<void> {
    const validatedPatch = validateExecutionTaskPatch(patch);
    const authority = await this.registryTasks.readRegistryTaskAuthority(teamName);
    if (!authority.backed && binding === undefined) {
      this.executionTaskStore.write(teamName, taskId, validatedPatch);
    } else {
      const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
      await this.withTaskAttestationJournal(teamName, taskId, registry, async (current) => {
        await current.writer.applyExecutionPatch(taskId, validatedPatch);
      });
    }
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    meta: TaskAttachmentMeta
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    await registry.writer.addAttachment(taskId, meta);
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    await registry.writer.removeAttachment(taskId, attachmentId);
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    await registry.writer.setNeedsClarification(taskId, value);
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related',
    binding?: RegistryTaskScope
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    try {
      await registry.writer.addLink({ taskId, targetId, type });
    } finally {
      this.invalidateGlobalTaskProjectionCache(teamName);
    }
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related',
    binding?: RegistryTaskScope
  ): Promise<void> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId, binding);
    try {
      await registry.writer.removeLink({ taskId, targetId, type });
    } finally {
      this.invalidateGlobalTaskProjectionCache(teamName);
    }
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    const comment = await registry.writer.appendUserComment(taskId, text, attachments, taskRefs);
    this.invalidateGlobalTaskProjectionCache(teamName);
    return comment;
  }

  private async buildEnrichedSendMessageRequest(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageRequest> {
    // Enrich with leadSessionId so session boundary separators work
    let enrichedRequest = request;
    if (!enrichedRequest.leadSessionId) {
      try {
        const config = await readConfigForUiSnapshot(this.configReader, teamName);
        if (config?.leadSessionId) {
          enrichedRequest = { ...enrichedRequest, leadSessionId: config.leadSessionId };
        }
      } catch {
        // non-critical
      }
    }
    const slashCommandMeta =
      enrichedRequest.slashCommand ?? buildStandaloneSlashCommandMeta(enrichedRequest.text);
    if (slashCommandMeta) {
      enrichedRequest = {
        ...enrichedRequest,
        messageKind: 'slash_command',
        slashCommand: slashCommandMeta,
      };
    }
    return enrichedRequest;
  }

  async sendMessage(teamName: string, request: SendMessageRequest): Promise<SendMessageResult> {
    if (request.from?.trim().toLowerCase() === 'system') {
      throw new Error('system is not a team member; use the system notification path');
    }
    const enrichedRequest = await this.buildEnrichedSendMessageRequest(teamName, request);
    const result = (await this.getController(teamName).messages.sendMessageAsync({
      member: enrichedRequest.member,
      from: enrichedRequest.from,
      text: enrichedRequest.text,
      timestamp: enrichedRequest.timestamp,
      messageId: enrichedRequest.messageId,
      to: enrichedRequest.to,
      color: enrichedRequest.color,
      conversationId: enrichedRequest.conversationId,
      replyToConversationId: enrichedRequest.replyToConversationId,
      toolSummary: enrichedRequest.toolSummary,
      toolCalls: enrichedRequest.toolCalls,
      messageKind: enrichedRequest.messageKind,
      workSyncIntent: enrichedRequest.workSyncIntent,
      workSyncIntentKey: enrichedRequest.workSyncIntentKey,
      workSyncReviewRequestEventIds: enrichedRequest.workSyncReviewRequestEventIds,
      slashCommand: enrichedRequest.slashCommand,
      commandOutput: enrichedRequest.commandOutput,
      taskRefs: enrichedRequest.taskRefs,
      actionMode: enrichedRequest.actionMode,
      commentId: enrichedRequest.commentId,
      summary: enrichedRequest.summary,
      source: enrichedRequest.source,
      leadSessionId: enrichedRequest.leadSessionId,
      attachments: enrichedRequest.attachments,
    })) as SendMessageResult;
    this.invalidateMessageFeed(teamName);
    return result;
  }

  async sendRuntimeRecipientMessage(
    teamName: string,
    request: SendMessageRequest
  ): Promise<SendMessageResult> {
    const enrichedRequest = await this.buildEnrichedSendMessageRequest(teamName, request);
    const result = await this.inboxWriter.sendMessage(teamName, enrichedRequest);
    this.invalidateMessageFeed(teamName);
    return result;
  }

  /**
   * Writes an app-originated notice into the lead inbox. `system` is not a team
   * member, so the controller's message_send path rejects it as a sender; the
   * notice goes straight to the inbox writer like the app's other system notices.
   * Without a readable config the lead inbox would be a guess, so it throws and
   * the caller retries instead of writing to `team-lead`.
   */
  async sendSystemNotificationToLead(args: {
    teamName: string;
    summary: string;
    text: string;
    taskRefs?: TaskRef[];
    messageId?: string;
  }): Promise<SendMessageResult> {
    const config = await readConfigForUiSnapshot(this.configReader, args.teamName);
    if (!config) {
      throw new Error(`Team config of ${args.teamName} is unavailable; lead notice not written`);
    }
    return this.sendRuntimeRecipientMessage(args.teamName, {
      member: this.resolveLeadNameFromConfig(config),
      from: 'system',
      summary: args.summary,
      text: args.text,
      ...(args.taskRefs && args.taskRefs.length > 0 ? { taskRefs: args.taskRefs } : {}),
      ...(args.messageId ? { messageId: args.messageId } : {}),
      source: TASK_COMMENT_NOTIFICATION_SOURCE,
    });
  }

  private resolveLeadNameFromConfig(config: TeamConfig | null): string {
    return resolveRuntimeLeadName(config?.members);
  }

  private async resolveLeadName(teamName: string): Promise<string> {
    try {
      const config = await readConfigForUiSnapshot(this.configReader, teamName);
      return this.resolveLeadNameFromConfig(config);
    } catch {
      return 'team-lead';
    }
  }

  private async resolveLeadRuntimeContext(
    teamName: string
  ): Promise<{ leadName: string; leadSessionId?: string }> {
    try {
      const config = await readConfigForUiSnapshot(this.configReader, teamName);
      return {
        leadName: this.resolveLeadNameFromConfig(config),
        leadSessionId: config?.leadSessionId,
      };
    } catch {
      return { leadName: 'team-lead' };
    }
  }

  private isLeadOwner(owner: string, leadName: string): boolean {
    const normalized = owner.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === leadName.trim().toLowerCase() || normalized === 'team-lead';
  }

  async sendDirectToLead(
    teamName: string,
    leadName: string,
    text: string,
    summary?: string,
    attachments?: AttachmentMeta[],
    taskRefs?: TaskRef[],
    messageId?: string,
    actionMode: AgentActionMode = 'do',
    fileReferences?: AttachmentMeta[]
  ): Promise<SendMessageResult> {
    let leadSessionId: string | undefined;
    try {
      const config = await readConfigForUiSnapshot(this.configReader, teamName);
      leadSessionId = config?.leadSessionId;
    } catch {
      // non-critical — proceed without sessionId
    }

    const slashCommandMeta = buildStandaloneSlashCommandMeta(text);
    const msg = this.getController(teamName).messages.appendSentMessage({
      from: 'user',
      to: leadName,
      text,
      taskRefs,
      summary,
      source: 'user_sent',
      actionMode,
      attachments: attachments?.length ? attachments : undefined,
      fileReferences: fileReferences?.length ? fileReferences : undefined,
      leadSessionId,
      ...(slashCommandMeta
        ? {
            messageKind: 'slash_command',
            slashCommand: slashCommandMeta,
          }
        : {}),
      ...(messageId ? { messageId } : {}),
    }) as InboxMessage;
    return {
      deliveredToInbox: false,
      deliveredViaStdin: true,
      messageId: msg.messageId ?? randomUUID(),
    };
  }

  async getLeadMemberName(teamName: string): Promise<string | null> {
    try {
      const config = await readConfigForUiSnapshot(this.configReader, teamName);

      // Check config.json members first (Claude Code-created teams)
      if (config?.members?.length) {
        const lead = config.members.find((m) => isLeadMember(m));
        if (lead?.name) return lead.name;
      }

      // Fallback: check members.meta.json (UI-created teams)
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const lead = metaMembers.find((m) => isLeadMember(m));
        if (lead?.name) return lead.name;
        return metaMembers[0]?.name ?? null;
      }

      // Last resort: check config.json first member
      return config?.members?.[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  async getTeamDisplayName(teamName: string): Promise<string> {
    try {
      const config = await this.readSnapshotConfig(teamName);
      const displayName = config?.name?.trim();
      return displayName || teamName;
    } catch {
      return teamName;
    }
  }

  async getTeamNotificationContext(teamName: string): Promise<TeamNotificationContext> {
    const now = Date.now();
    const generation = this.getNotificationContextGeneration(teamName);
    const cached = this.notificationContextCache.get(teamName);
    if (
      cached?.generation === generation &&
      now - cached.cachedAt < TEAM_NOTIFICATION_CONTEXT_CACHE_MAX_AGE_MS
    ) {
      return cached.value;
    }

    const existing = this.notificationContextInFlight.get(teamName);
    if (existing?.generation === generation) {
      return existing.promise;
    }

    const promise = this.readTeamNotificationContext(teamName, generation, now).finally(() => {
      if (this.notificationContextInFlight.get(teamName)?.promise === promise) {
        this.notificationContextInFlight.delete(teamName);
      }
    });
    this.notificationContextInFlight.set(teamName, { promise, generation });
    return promise;
  }

  private async readTeamNotificationContext(
    teamName: string,
    generationAtStart: number,
    now: number
  ): Promise<TeamNotificationContext> {
    try {
      const config = await this.readSnapshotConfig(teamName);
      const displayName = config?.name?.trim() || teamName;
      const projectPath =
        typeof config?.projectPath === 'string' && config.projectPath.trim().length > 0
          ? config.projectPath
          : undefined;
      const value: TeamNotificationContext = projectPath
        ? { displayName, projectPath }
        : { displayName };
      if (this.getNotificationContextGeneration(teamName) === generationAtStart) {
        this.notificationContextCache.set(teamName, {
          value,
          cachedAt: now,
          generation: generationAtStart,
        });
      }
      return value;
    } catch {
      const value = { displayName: teamName };
      if (this.getNotificationContextGeneration(teamName) === generationAtStart) {
        this.notificationContextCache.set(teamName, {
          value,
          cachedAt: now,
          generation: generationAtStart,
        });
      }
      return value;
    }
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    await this.updateKanban(teamName, taskId, { op: 'set_column', column: 'review' });
  }

  createTeamConfig(request: TeamCreateConfigRequest): Promise<void> {
    return this.runConfigurationOperation(request.teamName, () =>
      createDraftTeamConfig(request, {
        teamMetaStore: this.teamMetaStore,
        membersMetaStore: this.membersMetaStore,
      })
    );
  }

  /** The continuation keeps destination identity and lifecycle admission through draft provisioning. */
  readonly renameDraftTeam = (
    oldName: string,
    newName: string,
    afterRename?: () => Promise<void>
  ): Promise<void> =>
    this.runConfigurationOperation(oldName, async () => {
      if (oldName === newName) return afterRename?.();
      await assertDraftRenameDestinationAvailable(newName);
      return this.runConfigurationOperation(newName, async () => {
        await renameDraftTeamDirectory(oldName, newName);
        await afterRename?.();
      });
    });

  async reconcileTeamArtifacts(
    teamName: string,
    trigger?: FileWatchReconcileTrigger
  ): Promise<void> {
    const now = Date.now();
    const diagnostics = this.fileWatchReconcileDiagnostics.get(teamName) ?? {
      inFlight: 0,
      burstCount: 0,
      windowStartedAt: now,
      lastPressureLogAt: 0,
    };
    const triggerSource = trigger?.source ?? 'unknown';
    const triggerDetail =
      typeof trigger?.detail === 'string' && trigger.detail.trim().length > 0
        ? ` detail=${trigger.detail.trim()}`
        : '';
    if (now - diagnostics.windowStartedAt > 5_000) {
      diagnostics.windowStartedAt = now;
      diagnostics.burstCount = 0;
    }
    diagnostics.burstCount += 1;
    diagnostics.inFlight += 1;
    this.fileWatchReconcileDiagnostics.set(teamName, diagnostics);

    const concurrentAtStart = diagnostics.inFlight;
    const shouldLogPressure =
      concurrentAtStart > 1 || diagnostics.burstCount >= 8 || diagnostics.burstCount === 1;
    if (shouldLogPressure && now - diagnostics.lastPressureLogAt >= 2_000) {
      diagnostics.lastPressureLogAt = now;
      logger.warn(
        `[reconcileTeamArtifacts] team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} inFlight=${concurrentAtStart} burst=${diagnostics.burstCount}`
      );
    }

    const startedAt = Date.now();
    try {
      const rawResult = this.getController(teamName).maintenance.reconcileArtifacts({
        reason: 'file-watch',
      }) as
        | {
            staleKanbanEntriesRemoved?: number;
            staleColumnOrderRefsRemoved?: number;
            linkedCommentsCreated?: number;
          }
        | undefined;
      const result = (rawResult ?? {}) as {
        staleKanbanEntriesRemoved?: number;
        staleColumnOrderRefsRemoved?: number;
        linkedCommentsCreated?: number;
      };
      const durationMs = Date.now() - startedAt;
      if (
        durationMs >= 100 ||
        concurrentAtStart > 1 ||
        diagnostics.burstCount >= 8 ||
        (result.linkedCommentsCreated ?? 0) > 0 ||
        (result.staleKanbanEntriesRemoved ?? 0) > 0 ||
        (result.staleColumnOrderRefsRemoved ?? 0) > 0
      ) {
        logger.warn(
          `[reconcileTeamArtifacts] completed team=${teamName} reason=file-watch source=${triggerSource}${triggerDetail} durationMs=${durationMs} inFlightAtStart=${concurrentAtStart} burst=${diagnostics.burstCount} linkedCommentsCreated=${result.linkedCommentsCreated ?? 0} staleKanbanEntriesRemoved=${result.staleKanbanEntriesRemoved ?? 0} staleColumnOrderRefsRemoved=${result.staleColumnOrderRefsRemoved ?? 0}`
        );
      }
    } finally {
      const current = this.fileWatchReconcileDiagnostics.get(teamName);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        if (current.inFlight === 0 && Date.now() - current.windowStartedAt > 30_000) {
          this.fileWatchReconcileDiagnostics.delete(teamName);
        }
      }
    }
  }

  private async getLeadSessionJsonlPaths(projectDir: string): Promise<Map<string, string>> {
    const jsonlPaths = new Map<string, string>();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      return jsonlPaths;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length).trim();
      if (!sessionId || jsonlPaths.has(sessionId)) continue;
      jsonlPaths.set(sessionId, path.join(projectDir, entry.name));
    }

    return jsonlPaths;
  }

  private getRecentLeadSessionIds(config: TeamConfig): string[] {
    const sessionIds: string[] = [];
    const seen = new Set<string>();
    const pushSessionId = (value: unknown): void => {
      if (typeof value !== 'string') return;
      const sessionId = value.trim();
      if (!sessionId || seen.has(sessionId)) return;
      seen.add(sessionId);
      sessionIds.push(sessionId);
    };

    pushSessionId(config.leadSessionId);
    if (Array.isArray(config.sessionHistory)) {
      for (let i = config.sessionHistory.length - 1; i >= 0; i--) {
        pushSessionId(config.sessionHistory[i]);
      }
    }

    return sessionIds;
  }

  private async readLeadSessionJsonlTailLines(jsonlPath: string): Promise<string[]> {
    const MAX_SCAN_BYTES = 8 * 1024 * 1024;
    const handle = await fs.promises.open(jsonlPath, 'r');
    try {
      const stat = await handle.stat();
      const fileSize = stat.size;
      const scanBytes = Math.min(MAX_SCAN_BYTES, fileSize);
      const start = Math.max(0, fileSize - scanBytes);
      const buffer = Buffer.alloc(scanBytes);
      await handle.read(buffer, 0, scanBytes, start);
      const chunk = buffer.toString('utf8');

      const lines = chunk.split(/\r?\n/);
      const fromIndex = start > 0 ? 1 : 0;
      return lines
        .slice(fromIndex)
        .map((line) => line.trim())
        .filter(Boolean);
    } finally {
      await handle.close();
    }
  }

  private async extractLeadAssistantTextsFromJsonlLines(
    rawLines: readonly string[],
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]> {
    if (maxTexts <= 0) return [];
    const seenMessageIds = new Set<string>();
    const texts: InboxMessage[] = [];
    let syntheticBuffer: {
      firstMsg: Record<string, unknown>;
      firstMessage: Record<string, unknown>;
      timestamp: string;
      parts: string[];
    } | null = null;

    const collectToolCallsAfterIndex = (index: number): ToolCallMeta[] | undefined => {
      const toolCallsList: ToolCallMeta[] = [];
      const lookaheadLimit = Math.min(index + 200, rawLines.length);
      for (let j = index + 1; j < lookaheadLimit; j++) {
        const tLine = rawLines[j]?.trim();
        if (!tLine) continue;
        let tMsg: Record<string, unknown>;
        try {
          tMsg = JSON.parse(tLine) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (tMsg.type !== 'assistant') break;
        const tMessage = (tMsg.message ?? tMsg) as Record<string, unknown>;
        const tContent = tMessage.content;
        if (!Array.isArray(tContent)) continue;
        const tBlocks = tContent as Record<string, unknown>[];
        if (tBlocks.some((b) => b.type === 'text')) break;
        for (const b of tBlocks) {
          if (b.type === 'tool_use' && typeof b.name === 'string' && b.name !== 'SendMessage') {
            const input = (b.input ?? {}) as Record<string, unknown>;
            toolCallsList.push({
              name: b.name,
              preview: extractToolPreview(b.name, input),
            });
          }
        }
      }
      return toolCallsList.length > 0 ? toolCallsList : undefined;
    };

    const pushLeadText = (
      msg: Record<string, unknown>,
      message: Record<string, unknown>,
      combined: string,
      timestamp: string,
      toolCalls?: ToolCallMeta[],
      streamGroup = false
    ): void => {
      if (combined.length < MIN_TEXT_LENGTH) return;

      const entryUuid = typeof msg.uuid === 'string' ? msg.uuid.trim() : '';
      const assistantMessageId = typeof message.id === 'string' ? message.id.trim() : '';
      const stableMessageId = entryUuid
        ? streamGroup
          ? `lead-thought-stream-${entryUuid}`
          : `lead-thought-${entryUuid}`
        : assistantMessageId
          ? `lead-thought-msg-${assistantMessageId}`
          : null;

      const textPrefix = combined
        .slice(0, 50)
        .replace(/[^\p{L}\p{N}]/gu, '')
        .slice(0, 20);

      const messageId =
        stableMessageId ?? `lead-session-${leadSessionId}-${timestamp}-${textPrefix}`;
      if (seenMessageIds.has(messageId)) return;
      seenMessageIds.add(messageId);

      const toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
      texts.push({
        from: leadName,
        text: combined,
        timestamp,
        read: true,
        source: 'lead_session',
        leadSessionId,
        messageId,
        toolSummary,
        toolCalls,
      });
    };

    const flushSyntheticBuffer = (): void => {
      if (!syntheticBuffer) return;
      const combined = stripAgentBlocks(syntheticBuffer.parts.join('')).trim();
      pushLeadText(
        syntheticBuffer.firstMsg,
        syntheticBuffer.firstMessage,
        combined,
        syntheticBuffer.timestamp,
        undefined,
        true
      );
      syntheticBuffer = null;
    };

    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i]?.trim();
      if (!trimmed) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (msg.type !== 'assistant') {
        flushSyntheticBuffer();
        continue;
      }

      const message = (msg.message ?? msg) as Record<string, unknown>;
      const content = message.content;
      if (!Array.isArray(content)) {
        flushSyntheticBuffer();
        continue;
      }

      const textParts: string[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        textParts.push(block.text);
      }

      if (textParts.length === 0) {
        if ((content as Record<string, unknown>[]).some((block) => block.type === 'tool_use')) {
          flushSyntheticBuffer();
        }
        continue;
      }

      const timestamp =
        typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();
      const isSyntheticChunk = message.model === '<synthetic>' && message.type === 'message';
      if (isSyntheticChunk) {
        if (!syntheticBuffer) {
          syntheticBuffer = {
            firstMsg: msg,
            firstMessage: message,
            timestamp,
            parts: [],
          };
        }
        syntheticBuffer.parts.push(textParts.join(''));
        continue;
      }

      flushSyntheticBuffer();
      const combined = stripAgentBlocks(textParts.join('\n')).trim();
      pushLeadText(msg, message, combined, timestamp, collectToolCallsAfterIndex(i));
    }

    flushSyntheticBuffer();
    return texts.length > maxTexts ? texts.slice(-maxTexts) : texts;
  }

  private async extractLeadSessionTextsFromJsonl(
    jsonlPath: string,
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]> {
    const cacheKey: LeadSessionParseCacheKey = {
      jsonlPath,
      leadName,
      leadSessionId,
      maxTexts,
      schemaVersion: LEAD_SESSION_PARSE_CACHE_SCHEMA_VERSION,
    };
    const preParseSignature = await this.getLeadSessionFileSignature(jsonlPath);
    if (preParseSignature) {
      const cached = this.leadSessionParseCache.getIfFresh(cacheKey, preParseSignature);
      if (cached) {
        return cached;
      }

      const inFlight = this.leadSessionParseCache.getInFlight(cacheKey, preParseSignature);
      if (inFlight) {
        return inFlight;
      }
    }

    const parse = async (): Promise<InboxMessage[]> => {
      const rawLines = await this.readLeadSessionJsonlTailLines(jsonlPath);
      const [assistantTexts, commandResults] = await Promise.all([
        this.extractLeadAssistantTextsFromJsonlLines(rawLines, leadName, leadSessionId, maxTexts),
        extractLeadSessionMessagesFromJsonl({
          jsonlPath,
          leadName,
          leadSessionId,
          maxMessages: maxTexts,
          rawLines,
        }),
      ]);
      const combined = [...assistantTexts, ...commandResults];
      combined.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      return combined.length > maxTexts ? combined.slice(-maxTexts) : combined;
    };

    if (!preParseSignature) {
      return parse();
    }

    let resolveInFlight!: (messages: InboxMessage[]) => void;
    let rejectInFlight!: (error: unknown) => void;
    const parsePromise = new Promise<InboxMessage[]>((resolve, reject) => {
      resolveInFlight = resolve;
      rejectInFlight = reject;
    });
    this.leadSessionParseCache.setInFlight(cacheKey, preParseSignature, parsePromise);
    void parse().then(resolveInFlight, rejectInFlight);

    try {
      const combined = await parsePromise;
      const postParseSignature = await this.getLeadSessionFileSignature(jsonlPath);
      if (
        postParseSignature &&
        areLeadSessionFileSignaturesEqual(preParseSignature, postParseSignature)
      ) {
        this.leadSessionParseCache.set(cacheKey, postParseSignature, combined);
      }
      return combined;
    } finally {
      this.leadSessionParseCache.clearInFlight(cacheKey, preParseSignature);
    }
  }

  private async getLeadSessionFileSignature(
    jsonlPath: string
  ): Promise<LeadSessionFileSignature | null> {
    try {
      const stat = await fs.promises.stat(jsonlPath);
      if (!stat.isFile()) {
        return null;
      }
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(Number.isFinite(stat.ctimeMs) ? { ctimeMs: stat.ctimeMs } : {}),
      };
    } catch {
      return null;
    }
  }

  private async extractLeadSessionTexts(
    teamName: string,
    config: TeamConfig
  ): Promise<InboxMessage[]> {
    const knownLeadSessionIds = this.getRecentLeadSessionIds(config);
    if (knownLeadSessionIds.length === 0) {
      return [];
    }
    const sessionIds = knownLeadSessionIds;
    if (sessionIds.length === 0) {
      return [];
    }

    let transcriptContext = await this.projectResolver.getLiveBaseContext(teamName);
    if (!transcriptContext) {
      transcriptContext = await this.projectResolver.getContext(teamName, {
        includeTeamSubagentSessionDiscovery: false,
      });
    }
    if (!transcriptContext) {
      return [];
    }

    let availableJsonlPaths = await this.getLeadSessionJsonlPaths(transcriptContext.projectDir);
    const primaryLeadSessionId = sessionIds[0];
    const hasPrimaryLeadSessionPath = (): boolean =>
      Boolean(primaryLeadSessionId && availableJsonlPaths.has(primaryLeadSessionId));
    if (!hasPrimaryLeadSessionPath()) {
      const fallbackContext = await this.projectResolver.getContext(teamName, {
        includeTeamSubagentSessionDiscovery: false,
      });
      if (fallbackContext) {
        transcriptContext = fallbackContext;
        availableJsonlPaths = await this.getLeadSessionJsonlPaths(transcriptContext.projectDir);
      }
    }
    if (availableJsonlPaths.size === 0) {
      return [];
    }

    const leadName = resolveRuntimeLeadName(transcriptContext.config.members);
    const texts: InboxMessage[] = [];
    for (const sessionId of sessionIds) {
      if (texts.length >= MAX_LEAD_TEXTS) break;
      const jsonlPath = availableJsonlPaths.get(sessionId);
      if (!jsonlPath) continue;
      const remaining = MAX_LEAD_TEXTS - texts.length;
      const sessionTexts = await this.extractLeadSessionTextsFromJsonl(
        jsonlPath,
        leadName,
        sessionId,
        remaining
      );
      if (sessionTexts.length > 0) {
        texts.push(...sessionTexts);
      }
    }

    texts.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return texts.length > MAX_LEAD_TEXTS ? texts.slice(-MAX_LEAD_TEXTS) : texts;
  }

  async updateKanban(
    teamName: string,
    taskId: string,
    patch: UpdateKanbanPatch
  ): Promise<void | PendingKanbanTransitionSnapshot> {
    if (patch.op === 'inspect_pending' || patch.op === 'resolve_pending') {
      await this.requireRegistryTaskScope(teamName);
      if (!(await this.registryTaskProvider.readTaskSnapshot(teamName, taskId))) {
        throw new RegistryTaskProviderError({
          code: 'REGISTRY_TASK_NOT_FOUND',
          teamName,
          message: `Task "${taskId}" was not found in the published registry board.`,
        });
      }
    }
    if (patch.op === 'inspect_pending') {
      return this.getController(teamName).kanban.inspectPendingTransition(
        taskId
      ) as PendingKanbanTransitionSnapshot;
    }
    if (patch.op === 'resolve_pending') {
      this.getController(teamName).kanban.resolvePendingTransition(
        taskId,
        patch.transitionId,
        patch.snapshotHash,
        patch.mode,
        patch.contextHash
      );
      this.invalidateGlobalTaskProjectionCache(teamName);
      return;
    }

    const registry = await this.registryTasks.readRegistryTaskForWrite(teamName, taskId);
    const { task, writer } = registry;
    const { leadName } = await this.resolveLeadRuntimeContext(teamName);
    if (patch.op === 'remove') {
      await writer.transitionReview({ taskId, action: 'clear', actor: leadName });
    } else if (patch.op === 'set_column' && patch.column === 'review') {
      const state = await this.kanbanManager.getState(teamName);
      const reviewer = state.reviewers[0];
      await writer.transitionReview({ taskId, action: 'request', actor: leadName, reviewer });
      if (reviewer) {
        try {
          await this.sendMessage(teamName, {
            member: reviewer,
            from: leadName,
            text: `Please review task ${this.getTaskLabel(task)} "${task.subject}".`,
            summary: `Review request for ${this.getTaskLabel(task)}`,
            source: 'system_notification',
          });
        } catch {
          // Notification is best-effort after the review transition.
        }
      }
    } else if (patch.op === 'set_column') {
      await writer.transitionReview({
        taskId,
        action: 'approve',
        actor: leadName,
        manual: task.reviewState !== 'review',
      });
      if (task.owner) {
        try {
          await this.sendMessage(teamName, {
            member: task.owner,
            from: leadName,
            text: `@${leadName} approved task ${this.getTaskLabel(task)} "${task.subject}".`,
            summary: `Approved ${this.getTaskLabel(task)}`,
            source: 'system_notification',
          });
        } catch {
          // Notification is best-effort after the review transition.
        }
      }
    } else {
      if (!task.owner) throw new Error(`No owner found for task ${taskId}`);
      if (task.status !== 'completed' || task.reviewState !== 'review') {
        throw new Error(
          `Task #${taskId} must be completed and in review before requesting changes`
        );
      }
      const note = patch.comment?.trim() || 'Reviewer requested changes.';
      await writer.replaceStatus({
        taskId,
        to: 'pending',
        actor: leadName,
        expectedStatus: 'completed',
      });
      await writer.transitionReview({
        taskId,
        action: 'changes',
        actor: leadName,
        note,
        taskRefs: patch.taskRefs,
      });
      try {
        await this.sendMessage(teamName, {
          member: task.owner,
          from: leadName,
          text: `@${leadName} requested changes for task ${this.getTaskLabel(task)}.\n\n${note}\n\nThe task has been moved back to pending.`,
          taskRefs: patch.taskRefs,
          summary: `Fix request for ${this.getTaskLabel(task)}`,
          source: 'system_notification',
        });
      } catch {
        // Notification is best-effort after the review transition.
      }
    }
    this.invalidateGlobalTaskProjectionCache(teamName);
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    throw new RegistryTeamTaskWriteError(
      'OPERATION_UNSUPPORTED',
      'The registry task contract does not support manual kanban column ordering.',
      { details: { teamName, columnId, orderedTaskIds } }
    );
  }
}

function logTaskReadStages(
  teamName: string,
  authorityMs: number,
  readMs: number | null,
  taskCount: number | null
): void {
  const total = authorityMs + (readMs ?? 0);
  if (total < 1000) return;
  logger.warn(
    `[tasks:stages] team=${teamName} authority=${authorityMs}ms read=${readMs === null ? 'skipped' : `${readMs}ms`} tasks=${taskCount ?? 'n/a'}`
  );
}
