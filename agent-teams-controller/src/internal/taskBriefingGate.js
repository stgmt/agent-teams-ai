const agenda = require('./agenda.js');
const runtime = require('./runtime.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const { buildDeferredTaskQueueText } = require('./deferredTaskQueue.js');
const { isCodexMember, isOpenCodeMember } = require('./memberMessagingProtocol.js');

// task_briefing asked by a member. The startup context of a native member carries no
// Actionable work (deferredTaskQueue.js) so that the first turn ends and the app can confirm
// the launch; the work then arrives as messages (startupWork.js). A member can still call
// task_briefing in that first turn on its own, and work found there keeps the turn open: the
// launch is confirmed too late and fails. Until the app has confirmed the launch, the answer
// is therefore the same as the startup context says: the work arrives as messages. The
// confirmation is the app's fact, so the app is asked; when it does not answer, the member is
// told that, not given a briefing on a guess.

const DIAGNOSTICS_TIMEOUT_MS = 10000;
const MAX_REASON_CHARS = 160;

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function describeError(error) {
  const text = String(error && error.message ? error.message : error)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}...`;
}

function isHeldBackMember(context, memberName) {
  const key = normalizeKey(memberName);
  const members = runtimeHelpers.resolveTeamMembers(context.paths).members || [];
  const member = members.find((entry) => normalizeKey(entry && entry.name) === key) || null;
  if (!member) return false;
  if (key === normalizeKey(runtimeHelpers.inferLeadName(context.paths))) return false;
  // OpenCode and Codex members keep their task queue in the briefing (startupWork.js).
  return !isOpenCodeMember(member) && !isCodexMember(member);
}

async function readLaunchConfirmation(context, memberName) {
  let response;
  try {
    response = await runtime.getMemberDiagnostics(context, {
      waitTimeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(
      `task_briefing is not available: the app did not answer the launch check for ` +
        `${memberName} (${describeError(error)}). Your tasks arrive as messages after the app ` +
        `confirms your launch; ask for the briefing again once the app answers.`
    );
  }
  const key = normalizeKey(memberName);
  const entry = (Array.isArray(response && response.members) ? response.members : []).find(
    (candidate) => normalizeKey(candidate && candidate.memberName) === key
  );
  return entry ? entry.bootstrapConfirmed !== false : true;
}

async function requestTaskBriefing(context, memberName) {
  const name = String(memberName).trim();
  if (isHeldBackMember(context, name) && !(await readLaunchConfirmation(context, name))) {
    return buildDeferredTaskQueueText(name);
  }
  return agenda.formatTaskBriefing(context.paths, context.teamName, name);
}

module.exports = {
  requestTaskBriefing,
};
