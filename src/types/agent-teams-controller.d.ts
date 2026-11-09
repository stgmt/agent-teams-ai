declare module 'agent-teams-controller' {
  export const boardLocks: {
    withTeamBoardLock<T>(paths: { teamDir: string; claudeDir?: string }, fn: () => T): T;
    tryWithTeamBoardLock<T>(
      paths: { teamDir: string; claudeDir?: string },
      fn: () => T,
      options?: { createParent?: boolean }
    ): T | null;
  };
  export interface TaskFieldUpdates {
    subject?: string;
    description?: string;
    requirements?: string[];
    groupChatId?: string | null;
    artifactRequired?: boolean;
    artifactExpectedFilename?: string;
    artifactFile?: TaskArtifactFile;
  }

  export interface TaskArtifactProof {
    attachmentId: string;
    sha256: string;
    size: number;
  }
  export interface TaskArtifactFile {
    filename: string;
    base64Data: string;
  }

  export interface ControllerTaskScope {
    project: string;
    spec: string;
  }

  export type ControllerTaskRecord = Record<string, unknown> & {
    id: string;
    displayId?: string;
    subject: string;
    status: string;
    owner?: string | null | undefined;
    comments?: ControllerTaskCommentRecord[];
    attachments?: ControllerTaskAttachmentRecord[];
    historyEvents?: Record<string, unknown>[];
  };

  export type ControllerTaskCommentRecord = Record<string, unknown> & {
    id: string;
    author: string;
    text: string;
    createdAt: string;
    type: string;
  };
  export type ControllerTaskAttachmentRecord = Record<string, unknown> & {
    id: string;
    filePath?: string;
  };
  export interface ControllerTaskCommentResult extends Record<string, unknown> {
    commentId: string;
    taskId: string;
    subject: string;
    owner: string | null | undefined;
    task: ControllerTaskRecord;
    comment: ControllerTaskCommentRecord;
  }
  export type ControllerTaskMutationResult = Record<string, unknown> & {
    task: ControllerTaskRecord;
  };

  export interface ControllerTaskMutationOptions {
    scope?: ControllerTaskScope;
    trustedInternalWrite?: boolean;
  }

  export interface ControllerContextOptions {
    teamName: string;
    claudeDir?: string;
    allowUserMessageSender?: boolean;
    /** Use the local task board only for a controller without a desktop binding. */
    localTaskBoard?: true;
    /** Short-lived full-task snapshot for reads only; every canonical task write is rejected. */
    readOnlyTaskSnapshot?: ReadonlyArray<import('@shared/types').TeamTask>;
  }

  export interface ControllerTaskReadApi {
    getTask(taskId: string, scope?: ControllerTaskScope): ControllerTaskRecord;
    getTaskComment(
      taskId: string,
      commentId: string,
      scope?: ControllerTaskScope
    ): {
      comment: ControllerTaskCommentRecord;
      task: {
        id: string;
        displayId: string;
        subject: string;
        status: string;
        owner: string | null | undefined;
        commentCount: number;
      };
    };
    listTasks(scope?: ControllerTaskScope): ControllerTaskRecord[];
    listTaskInventory(filters?: Record<string, unknown>): Record<string, unknown>[];
    listDeletedTasks(scope?: ControllerTaskScope): ControllerTaskRecord[];
    resolveTaskId(taskRef: string, scope?: ControllerTaskScope): string;
  }

  export interface ControllerTaskWriteApi {
    createTask(flags: Record<string, unknown>): ControllerTaskRecord;
    setTaskStatus(
      taskId: string,
      status: string,
      actor?: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    startTask(taskId: string, actor?: string, scope?: ControllerTaskScope): ControllerTaskRecord;
    completeTask(taskId: string, actor?: string, scope?: ControllerTaskScope): ControllerTaskRecord;
    softDeleteTask(
      taskId: string,
      actor?: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    restoreTask(taskId: string, actor?: string, scope?: ControllerTaskScope): ControllerTaskRecord;
    setTaskOwner(
      taskId: string,
      owner: string | null,
      actor?: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    updateTaskFields(
      taskId: string,
      fields: TaskFieldUpdates,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    addTaskComment(
      taskId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskCommentResult;
    attachTaskFile(
      taskId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskMutationResult;
    attachCommentFile(
      taskId: string,
      commentId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskMutationResult;
    addTaskAttachmentMeta(
      taskId: string,
      meta: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    removeTaskAttachment(
      taskId: string,
      attachmentId: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    setNeedsClarification(
      taskId: string,
      value: string | null,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    linkTask(
      taskId: string,
      targetId: string,
      linkType: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    unlinkTask(
      taskId: string,
      targetId: string,
      linkType: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
  }

  export interface ControllerTaskBoardTaskApi
    extends ControllerTaskReadApi, ControllerTaskWriteApi {
    verifyTaskArtifact(taskId: string, scope?: ControllerTaskScope): TaskArtifactProof | null;
    readTaskArtifactData(
      taskId: string,
      attachmentId: string,
      scope?: ControllerTaskScope
    ): string | null;
    setTaskArtifactFile(
      taskId: string,
      file: TaskArtifactFile,
      actor?: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    reconcileTaskCreation(flags: Record<string, unknown>): ControllerTaskRecord;
    memberBriefing(
      memberName: string,
      options?: {
        runtimeProvider?: 'native' | 'opencode' | 'codex';
        includeActiveProcesses?: boolean;
        includeChatVisualizationProtocol?: boolean;
        /** Replace the task queue with the startup notice (no Actionable work in the startup context). */
        deferTaskQueue?: boolean;
      }
    ): Promise<string>;
    leadBriefing(): Promise<string>;
    taskBriefing(memberName: string): Promise<string>;
    requestTaskBriefing(memberName: string): Promise<string>;
    /** Task queue section of a startup context: no Actionable work, tasks arrive as messages. */
    deferredTaskBriefing(memberName: string): string;
    /** Hand the member its Actionable work as inbox messages once its launch is confirmed. */
    deliverStartupWork(
      memberName: string,
      options: { launchId: string }
    ): {
      memberName: string;
      delivered: {
        taskId: string;
        displayId: string;
        kind: 'assignment' | 'review';
        messageId: string;
      }[];
      skipped: { taskId: string; kind: 'assignment' | 'review'; reason: string }[];
    };
  }

  export interface ControllerTaskApi extends ControllerTaskReadApi {
    createTask(flags: Record<string, unknown>): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.setTaskStatus. */
    setTaskStatus(
      taskId: string,
      status: string,
      actor?: string,
      options?: ControllerTaskMutationOptions
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.startTask. */
    startTask(
      taskId: string,
      actor?: string,
      options?: ControllerTaskMutationOptions
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.completeTask. */
    completeTask(
      taskId: string,
      actor?: string,
      options?: ControllerTaskMutationOptions
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.softDeleteTask. */
    softDeleteTask(
      taskId: string,
      actor?: string,
      options?: ControllerTaskMutationOptions
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.restoreTask. */
    restoreTask(
      taskId: string,
      actor?: string,
      options?: ControllerTaskMutationOptions
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.setTaskOwner. */
    setTaskOwner(
      taskId: string,
      owner: string | null,
      actor?: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.updateTaskFields. */
    updateTaskFields(
      taskId: string,
      fields: TaskFieldUpdates,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.addTaskComment. */
    addTaskComment(
      taskId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskCommentResult;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.attachTaskFile. */
    attachTaskFile(
      taskId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskMutationResult;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.attachCommentFile. */
    attachCommentFile(
      taskId: string,
      commentId: string,
      flags: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskMutationResult;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.addTaskAttachmentMeta. */
    addTaskAttachmentMeta(
      taskId: string,
      meta: Record<string, unknown>,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.removeTaskAttachment. */
    removeTaskAttachment(
      taskId: string,
      attachmentId: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.setNeedsClarification. */
    setNeedsClarification(
      taskId: string,
      value: string | null,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.linkTask. */
    linkTask(
      taskId: string,
      targetId: string,
      linkType: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    /** @deprecated Internal task lifecycle write. Use controller.taskBoard.unlinkTask. */
    unlinkTask(
      taskId: string,
      targetId: string,
      linkType: string,
      scope?: ControllerTaskScope
    ): ControllerTaskRecord;
    reconcileTaskCreation(flags: Record<string, unknown>): ControllerTaskRecord;
    memberBriefing(
      memberName: string,
      options?: {
        runtimeProvider?: 'native' | 'opencode' | 'codex';
        includeActiveProcesses?: boolean;
        includeChatVisualizationProtocol?: boolean;
      }
    ): Promise<string>;
    leadBriefing(): Promise<string>;
    taskBriefing(memberName: string): Promise<string>;
  }

  export type KanbanTransitionRecoveryMode = 'cancel' | 'publish' | 'clear' | 'conflict';
  export interface PendingKanbanTransitionInspection {
    taskId: string;
    contextHash: string;
    transitionId: string;
    column: string;
    currentColumn: string | null;
    targetStatus?: string;
    phase: 'prepared' | 'applied';
    operation?: string;
    mode: KanbanTransitionRecoveryMode;
    reason?: 'artifact_invalid';
    snapshotHash: string;
  }
  export interface ControllerKanbanReadApi {
    getKanbanState(): unknown;
    listReviewers(): string[];
    assertKanbanStateConsistent(state?: unknown): unknown;
    inspectPendingTransition(taskId: string): PendingKanbanTransitionInspection;
  }

  export interface ControllerKanbanWriteApi {
    setKanbanColumn(taskId: string, column: string, options?: Record<string, unknown>): unknown;
    clearKanban(taskId: string): unknown;
    addReviewer(reviewer: string): string[];
    removeReviewer(reviewer: string): string[];
    updateColumnOrder(columnId: string, orderedTaskIds: string[]): unknown;
    resolvePendingTransition(
      taskId: string,
      transitionId: string,
      snapshotHash: string,
      mode: Exclude<KanbanTransitionRecoveryMode, 'conflict'>,
      contextHash: string
    ): void;
  }

  export interface ControllerTaskBoardKanbanApi
    extends ControllerKanbanReadApi, ControllerKanbanWriteApi {}

  export interface ControllerKanbanApi extends ControllerTaskBoardKanbanApi {
    readKanbanStateAlreadyLocked(): unknown;
    /** @deprecated Internal board lifecycle write. Use controller.taskBoard.setKanbanColumn. */
    setKanbanColumn(taskId: string, column: string, options?: Record<string, unknown>): unknown;
    /** @deprecated Internal board lifecycle write. Use controller.taskBoard.clearKanban. */
    clearKanban(taskId: string): unknown;
    /** @deprecated Internal board lifecycle write. Use controller.taskBoard.addReviewer. */
    addReviewer(reviewer: string): string[];
    /** @deprecated Internal board lifecycle write. Use controller.taskBoard.removeReviewer. */
    removeReviewer(reviewer: string): string[];
    /** @deprecated Internal board lifecycle write. Use controller.taskBoard.updateColumnOrder. */
    updateColumnOrder(columnId: string, orderedTaskIds: string[]): unknown;
  }

  export interface ControllerReviewWriteApi {
    requestReview(taskId: string, flags?: Record<string, unknown>): unknown;
    approveReview(taskId: string, flags?: Record<string, unknown>): unknown;
    requestChanges(taskId: string, flags?: Record<string, unknown>): unknown;
    startReview(taskId: string, flags?: Record<string, unknown>): unknown;
  }

  export interface ControllerReviewApi extends ControllerReviewWriteApi {
    /** @deprecated Internal review lifecycle write. Use controller.taskBoard.requestReview. */
    requestReview(taskId: string, flags?: Record<string, unknown>): unknown;
    /** @deprecated Internal review lifecycle write. Use controller.taskBoard.approveReview. */
    approveReview(taskId: string, flags?: Record<string, unknown>): unknown;
    /** @deprecated Internal review lifecycle write. Use controller.taskBoard.requestChanges. */
    requestChanges(taskId: string, flags?: Record<string, unknown>): unknown;
    /** @deprecated Internal review lifecycle write. Use controller.taskBoard.startReview. */
    startReview(taskId: string, flags?: Record<string, unknown>): unknown;
  }

  export interface ControllerTaskBoardApi
    extends ControllerTaskBoardTaskApi, ControllerTaskBoardKanbanApi, ControllerReviewWriteApi {
    /**
     * Board facts for lead reports. Snapshot contexts avoid waiting on the board
     * lock; other contexts retain it so unreadable or ambiguous rows throw.
     */
    readLeadReportFacts(): unknown[];
    /** Configured member or lead alias, by the task owner rules; leadName is the configured lead. */
    resolveTaskActor(actor: string): { memberName: string | null; leadName: string | null };
    /** Snapshot-only hand-over that uses asynchronous inbox persistence. */
    deliverStartupWorkAsync(
      memberName: string,
      options: { launchId: string; isCurrent: () => boolean }
    ): Promise<{
      memberName: string;
      delivered: {
        taskId: string;
        displayId: string;
        kind: 'assignment' | 'review';
        messageId: string;
      }[];
      skipped: { taskId: string; kind: 'assignment' | 'review'; reason: string }[];
      cancelled?: true;
    }>;
  }

  export interface ControllerMessageApi {
    appendSentMessage(flags: Record<string, unknown>): unknown;
    lookupMessage(messageId: string): { message: Record<string, unknown>; store: string };
    sendMessage(flags: Record<string, unknown>): unknown;
    sendMessageAsync(flags: Record<string, unknown>): Promise<unknown>;
  }

  export interface ControllerProcessApi {
    registerProcess(flags: Record<string, unknown>): unknown;
    stopProcess(flags: Record<string, unknown>): unknown;
    unregisterProcess(flags: Record<string, unknown>): unknown;
    /**
     * `readOnly` leaves processes.json as it is. A stopped row it cannot settle
     * gets a stable stoppedAt estimate (the row's registeredAt).
     */
    listProcesses(flags?: { readOnly?: boolean }): unknown[];
  }

  export interface ControllerCrossTeamApi {
    sendCrossTeamMessage(flags: Record<string, unknown>): unknown;
    listCrossTeamTargets(flags?: Record<string, unknown>): unknown;
    getCrossTeamOutbox(): unknown;
  }

  export interface ControllerRuntimeApi {
    /** Keep the shared runtime surface in sync with mcp-server's ambient declaration. */
    getConnectionInfo(): Promise<unknown>;
    getMemberRosterContext(
      memberName: string,
      launchMembers?: { name: string; role?: string; agentType?: string; removedAt?: number }[]
    ): string;
    listTeams(flags?: Record<string, unknown>): Promise<unknown>;
    getTeam(flags?: Record<string, unknown>): Promise<unknown>;
    createTeam(flags: Record<string, unknown>): Promise<unknown>;
    updateTeam(flags: Record<string, unknown>): Promise<unknown>;
    trashTeam(flags: Record<string, unknown>): Promise<unknown>;
    launchTeam(flags: Record<string, unknown>): Promise<unknown>;
    stopTeam(flags?: Record<string, unknown>): Promise<unknown>;
    getRuntimeState(flags?: Record<string, unknown>): Promise<unknown>;
    getMemberDiagnostics(flags?: Record<string, unknown>): Promise<unknown>;
    runtimeBootstrapCheckin(flags: Record<string, unknown>): Promise<unknown>;
    runtimeDeliverMessage(flags: Record<string, unknown>): Promise<unknown>;
    runtimeTaskEvent(flags: Record<string, unknown>): Promise<unknown>;
    runtimeHeartbeat(flags: Record<string, unknown>): Promise<unknown>;
  }

  export interface ControllerTeamSpecBinding {
    project: string;
    spec: string;
  }

  export interface ControllerSpecBindingsApi {
    listTeamSpecBindings(scopeCredential?: string | null): ControllerTeamSpecBinding[];
    linkTeamSpec(
      binding: ControllerTeamSpecBinding,
      scopeCredential?: string | null
    ): ControllerTeamSpecBinding[];
  }

  export interface AgentBlocksApi {
    AGENT_BLOCK_TAG: string;
    AGENT_BLOCK_OPEN: string;
    AGENT_BLOCK_CLOSE: string;
    AGENT_BLOCK_RE: RegExp;
    stripAgentBlocks(text: string): string;
    wrapAgentBlock(text: string): string;
  }

  export interface AgentTeamsController {
    tasks: ControllerTaskApi;
    kanban: ControllerKanbanApi;
    review: ControllerReviewApi;
    taskBoard: ControllerTaskBoardApi;
    maintenance: { reconcileArtifacts(flags?: Record<string, unknown>): unknown };
    messages: ControllerMessageApi;
    processes: ControllerProcessApi;
    crossTeam: ControllerCrossTeamApi;
    runtime: ControllerRuntimeApi;
    groupChats: {
      createGroupChat(flags: {
        from: string;
        sourceMessageId: string;
        name: string;
        selectedMemberNames: string[];
        autoIncludeNewMembers?: boolean;
      }): Promise<unknown>;
      listGroupChats(flags: Record<string, unknown>): Promise<unknown>;
      sendGroupMessage(flags: Record<string, unknown>): Promise<unknown>;
      reactToGroupMessage(flags: {
        from: string;
        groupChatId: string;
        relayOfMessageId: string;
      }): Promise<{
        teamName: string;
        saved: true;
        acknowledged: true;
        groupChatId: string;
        messageId: string;
        relayOfMessageId: string;
        from: string;
        groupRunKey: string;
      }>;
    };
    workSync: ControllerWorkSyncApi;
  }

  /** Context-free protocol text builders, shared across lead and member prompts. */
  export interface ProtocolsApi {
    buildChatVisualizationProtocolText(): string;
    buildChatVisualizationRefreshInstruction(): string;
    buildActionModeProtocolText(delegateDescription: string): string;
    MEMBER_DELEGATE_DESCRIPTION: string;
    buildProcessProtocolText(teamName: string): string;
  }

  /** Context-free text classifiers shared with the MCP server. */
  export interface TaskTextSignalsApi {
    isTaskCompletionClaimText(text: string): boolean;
  }

  export type AgentTeamsMcpToolGroupId =
    | 'team'
    | 'task'
    | 'teamSpec'
    | 'lead'
    | 'kanban'
    | 'review'
    | 'message'
    | 'process'
    | 'runtime'
    | 'crossTeam';

  export interface AgentTeamsMcpToolGroup {
    id: AgentTeamsMcpToolGroupId;
    teammateOperational: boolean;
    toolNames: readonly string[];
  }

  export function createController(options: ControllerContextOptions): AgentTeamsController;

  export const agentBlocks: AgentBlocksApi;

  export const protocols: ProtocolsApi;

  export const taskTextSignals: TaskTextSignalsApi;
  export const appScopedSpecBindings: ControllerSpecBindingsApi;
  export const AGENT_TEAMS_MANAGEMENT_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_TASK_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_LEAD_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_REVIEW_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_MESSAGE_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_CROSS_TEAM_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_PROCESS_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_KANBAN_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_RUNTIME_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_MCP_TOOL_GROUPS: readonly AgentTeamsMcpToolGroup[];
  export const AGENT_TEAMS_REGISTERED_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_LEAD_BOOTSTRAP_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES: readonly string[];
  export const AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES: readonly string[];
}
