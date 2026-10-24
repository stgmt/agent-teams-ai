// Task queue section of the startup briefing. The app builds the native
// bootstrap context for a member before the member's first turn. A queue with
// Actionable work makes the runtime keep the member working in that same turn,
// so the launch is only confirmed once the work is finished. The startup
// context therefore carries no work; the app hands the work over as separate
// messages once the launch is confirmed (see startupWork.js).

function buildDeferredTaskQueueText(memberName) {
    return [
        `Task briefing for ${memberName}:`,
        `No Actionable work is loaded in this startup context.`,
        `Your assigned tasks and review requests reach you as separate "New task assigned" and "Please review" messages after the app confirms your launch.`,
        `Do not call task_briefing or task_list during this startup turn. Act on the messages when they arrive.`,
    ].join('\n');
}

module.exports = {
    buildDeferredTaskQueueText,
};
