const agenda = require('./agenda.js');
const messages = require('./messages.js');
const messageStore = require('./messageStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const taskStore = require('./taskStore.js');
const { isReadOnlyTaskSnapshot } = require('./taskBackendSelection.js');
const { buildAssignmentMessage } = require('./taskAssignmentMessage.js');
const { buildReviewRequestText } = require('./reviewRequestMessage.js');
const {
    createMemberMessagingProtocol,
    resolveMemberRuntimeProvider,
} = require('./memberMessagingProtocol.js');

// Work hand-over at launch. The startup context of a member carries no
// Actionable work (deferredTaskQueue.js): the runtime keeps a member with work
// in its first turn and the launch confirmation would not arrive within the
// window. The app calls deliverStartupWork after confirmation; snapshot-backed
// handovers use its async variant so inbox locks never block the app thread.
// Both send through the same inbox path as an ordinary assignment or review request.

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

function hasUnreadNotice(unreadRows, taskId, summary) {
    return unreadRows.some(
        (row) =>
            row.summary === summary &&
            Array.isArray(row.taskRefs) &&
            row.taskRefs.some((ref) => ref && String(ref.taskId || '').trim() === taskId)
    );
}

function prepareStartupWorkPlan(context, memberName, options = {}) {
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
    const messagingProtocol = createMemberMessagingProtocol(resolveMemberRuntimeProvider(member));
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

    return {
        launchId,
        memberName: resolvedName,
        items,
        unreadRows,
        messagingProtocol,
        leadName,
        leadSessionId,
    };
}

function prepareStartupWorkMessage(context, plan, item) {
    const isReview = item.nextAction === 'review';
    const kind = isReview ? 'review' : 'assignment';
    const task = taskStore.readTask(context.paths, item.taskId);
    const summary = isReview ? reviewSummary(task) : assignmentSummary(task);
    if (hasUnreadNotice(plan.unreadRows, task.id, summary)) {
        return { skipped: { taskId: task.id, kind, reason: 'unread_notification_exists' } };
    }
    const text = isReview
        ? buildReviewRequestText(context, task, { launchId: plan.launchId })
        : buildAssignmentMessage(context, task, {
              messagingProtocol: plan.messagingProtocol,
              startup: { launchId: plan.launchId, status: task.status, reasonCode: item.reasonCode },
          });
    const messageId = `startup-work:${plan.launchId}:${plan.memberName.toLowerCase()}:${task.id}:${kind}`;
    return {
        taskId: task.id,
        displayId: task.displayId || task.id,
        kind,
        flags: {
            member: plan.memberName,
            from: plan.leadName,
            text,
            taskRefs: [
                { taskId: task.id, displayId: task.displayId || task.id, teamName: context.teamName },
            ],
            summary,
            source: 'system_notification',
            messageId,
            ...(plan.leadSessionId ? { leadSessionId: plan.leadSessionId } : {}),
        },
    };
}

function recordStartupWorkSend(item, sent, delivered, skipped) {
    if (sent.deduplicated) {
        skipped.push({ taskId: item.taskId, kind: item.kind, reason: 'duplicate_message' });
        return;
    }
    delivered.push({
        taskId: item.taskId,
        displayId: item.displayId,
        kind: item.kind,
        messageId: item.flags.messageId,
    });
}

function deliverStartupWork(context, memberName, options = {}) {
    const plan = prepareStartupWorkPlan(context, memberName, options);
    const delivered = [];
    const skipped = [];
    for (const item of plan.items) {
        const prepared = prepareStartupWorkMessage(context, plan, item);
        if (prepared.skipped) {
            skipped.push(prepared.skipped);
            continue;
        }
        recordStartupWorkSend(
            prepared,
            messages.sendMessage(context, prepared.flags),
            delivered,
            skipped
        );
    }
    return { memberName: plan.memberName, delivered, skipped };
}

async function deliverStartupWorkAsync(context, memberName, options = {}) {
    if (!isReadOnlyTaskSnapshot(context.paths)) {
        throw new Error('deliverStartupWorkAsync requires a read-only task snapshot');
    }
    if (typeof options.isCurrent !== 'function') {
        throw new Error('deliverStartupWorkAsync requires options.isCurrent');
    }
    const isCurrent = options.isCurrent;
    const plan = prepareStartupWorkPlan(context, memberName, options);
    const delivered = [];
    const skipped = [];
    if (!isCurrent()) {
        return { memberName: plan.memberName, delivered, skipped, cancelled: true };
    }
    for (const item of plan.items) {
        if (!isCurrent()) {
            return { memberName: plan.memberName, delivered, skipped, cancelled: true };
        }
        const prepared = prepareStartupWorkMessage(context, plan, item);
        if (prepared.skipped) {
            skipped.push(prepared.skipped);
            continue;
        }
        const sent = await messages.sendMessageAsync(context, prepared.flags, { isCurrent });
        if (sent.cancelled) {
            return { memberName: plan.memberName, delivered, skipped, cancelled: true };
        }
        recordStartupWorkSend(prepared, sent, delivered, skipped);
    }
    return { memberName: plan.memberName, delivered, skipped };
}

module.exports = {
    deliverStartupWork,
    deliverStartupWorkAsync,
};
