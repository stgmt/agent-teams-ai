const { wrapAgentBlock } = require('./agentBlocks.js');

// Text a reviewer receives for a task in the review column. Shared by the live
// review request (review.js) and the hand-over at launch (startupWork.js), so a
// reviewer reads the same instructions either way.
function buildReviewRequestText(context, task, options = {}) {
  const launchNotice =
    typeof options.launchId === 'string' && options.launchId.trim()
      ? `The app delivered this request after launch ${options.launchId.trim()}: the task was already waiting for your review.\n\n`
      : '';
  return (
    `**Please review** task #${task.displayId || task.id}\n\n` +
    launchNotice +
    wrapAgentBlock(
      `This request is for the CURRENT review cycle. If you reviewed this task earlier, do not treat this message as a duplicate while the task is still in review; prior approvals become stale after later work.\n\n` +
        `Before declaring it duplicate, call task_get and check the current reviewState/status. If it is still in review for you, continue with the review tools below.\n\n` +
        `FIRST call review_start to signal you are beginning the review:\n` +
        `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>" }\n\n` +
        `When approved, use MCP tool review_approve:\n` +
        `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>", note?: "<optional note>", notifyOwner: true }\n\n` +
        `If changes are needed, use MCP tool review_request_changes:\n` +
        `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>", comment: "..." }`
    )
  );
}

module.exports = {
  buildReviewRequestText,
};
