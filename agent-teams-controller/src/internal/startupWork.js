const agenda = require('./agenda.js');
const messages = require('./messages.js');
const messageStore = require('./messageStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const taskStore = require('./taskStore.js');
const { buildAssignmentMessage } = require('./taskAssignmentMessage.js');
const { buildReviewRequestText } = require('./reviewRequestMessage.js');
const {
    createMemberMessagingProtocol,
    isCodexMember,
    isOpenCodeMember,
} = require('./memberMessagingProtocol.js');

// Work hand-over at launch. The startup context of a member carries no
// Actionable work (deferredTaskQueue.js): the runtime keeps a member with work
// in its first turn and the launch confirmation would not arrive within the
// window. Once the app has confirmed the launch it calls deliverStartupWork,
// which sends the member one message per task it has to act on, through the same
// inbox path as an ordinary assignment or review request.

// in_progress work is resumed first, then fixes after review, then new tasks,
// then reviews (the order the member briefing asks for on reconnect).
const REASON_PRIORITY = {
    owner_executing: 0,
    needs_fix: 1,
    owner_ready: 2,
    review_in_progress: 3,
    review_requested_waiting_pickup: 3,
};

function assignmentSummary(task) {
    return `New task #${task.displayId || task.id} assigned`;
}

function reviewSummary(task) {
    return `Review request for #${task.displayId || task.id}`;
}

function resolveRuntimeProvider(member) {
    if (isOpenCodeMember(member)) return 'opencode';
    if (isCodexMember(member)) return 'codex';
    return 'native';
}

function hasUnreadNotice(unreadRows, taskId, summary) {
    return unreadRows.some(
        (row) =>
            row.summary === summary &&
            Array.isArray(row.taskRefs) &&
            row.taskRefs.some((ref) => ref && String(ref.taskId || '').trim() === taskId)
    );
}

function deliverStartupWork(context, memberName, options = {}) {
    const launchId = typeof options.launchId === 'string' ? options.launchId.trim() : '';
    if (!launchId) {
        throw new Error('deliverStartupWork requires options.launchId');
    }
    const resolvedName = runtimeHelpers.assertExplicitTeamMemberName(
        context.paths,
        memberName,
        'member'
    );
    const members = runtimeHelpers.resolveTeamMembers(context.paths).members || [];
    const member =
        members.find(
            (entry) =>
                String((entry && entry.name) || '').trim().toLowerCase() === resolvedName.toLowerCase()
        ) || null;
    const messagingProtocol = createMemberMessagingProtocol(resolveRuntimeProvider(member));
    const leadName = runtimeHelpers.inferLeadName(context.paths);
    const leadSessionId = runtimeHelpers.resolveLeadSessionId(context.paths);

    const snapshot = agenda.buildAgendaSnapshot(context.paths, context.teamName, {
        kind: 'member',
        memberName: resolvedName,
    });
    const items = snapshot.actionable
        .map((item, index) => ({ item, index }))
        .sort(
            (left, right) =>
                (REASON_PRIORITY[left.item.reasonCode] ?? 9) -
                    (REASON_PRIORITY[right.item.reasonCode] ?? 9) || left.index - right.index
        )
        .map((entry) => entry.item);
    const unreadRows = messageStore.listUnreadSystemNotifications(context.paths, resolvedName);

    const delivered = [];
    const skipped = [];
    for (const item of items) {
        const isReview = item.nextAction === 'review';
        const kind = isReview ? 'review' : 'assignment';
        const task = taskStore.readTask(context.paths, item.taskId);
        const summary = isReview ? reviewSummary(task) : assignmentSummary(task);
        if (hasUnreadNotice(unreadRows, task.id, summary)) {
            skipped.push({ taskId: task.id, kind, reason: 'unread_notification_exists' });
            continue;
        }
        const text = isReview
            ? buildReviewRequestText(context, task, { launchId })
            : buildAssignmentMessage(context, task, {
                  messagingProtocol,
                  startup: { launchId, status: task.status, reasonCode: item.reasonCode },
              });
        const messageId = `startup-work:${launchId}:${resolvedName.toLowerCase()}:${task.id}:${kind}`;
        const sent = messages.sendMessage(context, {
            member: resolvedName,
            from: leadName,
            text,
            taskRefs: [
                { taskId: task.id, displayId: task.displayId || task.id, teamName: context.teamName },
            ],
            summary,
            source: 'system_notification',
            messageId,
            ...(leadSessionId ? { leadSessionId } : {}),
        });
        if (sent.deduplicated) {
            skipped.push({ taskId: task.id, kind, reason: 'duplicate_message' });
            continue;
        }
        delivered.push({ taskId: task.id, displayId: task.displayId || task.id, kind, messageId });
    }

    return { memberName: resolvedName, delivered, skipped };
}

module.exports = {
    deliverStartupWork,
};
