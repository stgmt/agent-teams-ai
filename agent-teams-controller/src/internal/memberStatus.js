const fs = require('fs');
const path = require('path');

const agenda = require('./agenda.js');
const runtime = require('./runtime.js');
const runtimeHelpers = require('./runtimeHelpers.js');

// The "Members" section of lead_briefing. The lead gets facts about every member without
// asking the member: liveness from the app (the member diagnostics route), delivery from the
// member inbox (the `read` flag), work and its ages from the board. Each source is read on its
// own; one that cannot be read is named in the text, never replaced by a guess.

const MINUTE_MS = 60 * 1000;
const MAX_ACTIONABLE_LINES = 10;
const MAX_WATCHING_LINES = 5;
const MAX_PREVIEW_CHARS = 60;
const MAX_REASON_CHARS = 160;
const DIAGNOSTICS_TIMEOUT_MS = 10000;

function normalizeName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeKey(value) {
  return normalizeName(value).toLowerCase();
}

function truncate(value, maxChars) {
  const text = normalizeName(value).replace(/\s+/g, ' ');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

// The fields of a member line are joined with "; ". A reason from the app (it joins its own
// reasons with a semicolon) is one field, so its semicolons become commas.
function lineField(value, maxChars) {
  return truncate(value, maxChars).replace(/;/g, ',');
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.floor(Math.max(ms, 0) / MINUTE_MS);
  if (minutes < 1) return '<1m';
  if (minutes < 120) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 72) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ageSince(iso, nowMs) {
  const at = Date.parse(normalizeName(iso));
  return Number.isFinite(at) ? formatAge(nowMs - at) : null;
}

function describeError(error) {
  return lineField(error && error.message ? error.message : String(error), MAX_REASON_CHARS);
}

function listRosterNames(paths) {
  const explicit = runtimeHelpers.collectExplicitTeamMembers(paths);
  const leadKey = normalizeKey(runtimeHelpers.inferLeadName(paths));
  const names = [...explicit.membersByKey.values()]
    .map((member) => normalizeName(member.name))
    .filter(Boolean);
  names.sort((left, right) => {
    const leftLead = normalizeKey(left) === leadKey ? 0 : 1;
    const rightLead = normalizeKey(right) === leadKey ? 0 : 1;
    return leftLead - rightLead || left.localeCompare(right);
  });
  return { names, leadKey };
}

async function readAppDiagnostics(context) {
  try {
    const response = await runtime.getMemberDiagnostics(context, {
      waitTimeoutMs: DIAGNOSTICS_TIMEOUT_MS,
    });
    const entries = new Map();
    for (const entry of Array.isArray(response && response.members) ? response.members : []) {
      const key = normalizeKey(entry && entry.memberName);
      if (key) entries.set(key, entry);
    }
    return { entries, unavailableReason: null };
  } catch (error) {
    return { entries: new Map(), unavailableReason: describeError(error) };
  }
}

function describeLiveness(diagnostics, memberName, nowMs) {
  if (diagnostics.unavailableReason) return 'running=no data';
  const entry = diagnostics.entries.get(normalizeKey(memberName));
  if (!entry) return 'running=no data (not in app diagnostics)';

  // `alive` is the app's own check of the process; it wins when present. `runtimeAlive` is
  // the launch record and stays true after the process is gone, so it only answers when
  // the app gave no process check, and never for a member whose launch failed.
  const running =
    typeof entry.alive === 'boolean'
      ? entry.alive
      : entry.runtimeAlive === true && entry.launchState !== 'failed_to_start';
  const parts = [
    `running=${running ? 'yes' : 'no'}`,
    `launch=${normalizeName(entry.launchState) || normalizeName(entry.spawnStatus) || 'none'}`,
    `confirmed=${entry.bootstrapConfirmed === true ? 'yes' : 'no'}`,
  ];
  const heartbeat = ageSince(entry.lastHeartbeatAt, nowMs);
  if (heartbeat) parts.push(`heartbeat ${heartbeat} ago`);
  const failure =
    normalizeName(entry.memberCardError) ||
    (entry.hardFailure === true
      ? normalizeName(entry.hardFailureReason) || normalizeName(entry.error)
      : '');
  if (failure) parts.push(`failure: ${lineField(failure, MAX_REASON_CHARS)}`);
  const processNote = running || failure ? '' : normalizeName(entry.runtimeDiagnostic);
  if (processNote) parts.push(`note: ${lineField(processNote, MAX_REASON_CHARS)}`);
  return parts.join(', ');
}

function describeInbox(paths, memberName, nowMs) {
  let rows;
  try {
    const safeName = runtimeHelpers.assertSafeMemberFileSegment('member name', memberName);
    const file = path.join(paths.teamDir, 'inboxes', `${safeName}.json`);
    try {
      rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return 'unread=0';
      }
      throw error;
    }
    if (!Array.isArray(rows)) throw new Error('inbox file is not a list of messages');
  } catch (error) {
    return `inbox unreadable (${describeError(error)})`;
  }

  let unread = 0;
  let oldest = null;
  for (const row of rows) {
    if (!row || row.read !== false) continue;
    unread += 1;
    const at = Date.parse(normalizeName(row.timestamp));
    if (Number.isFinite(at) && (!oldest || at < oldest.at)) oldest = { at, row };
  }
  if (unread === 0) return 'unread=0';
  if (!oldest) return `unread=${unread}`;

  const sender = normalizeName(oldest.row.from) || 'unknown';
  const preview = truncate(oldest.row.summary || oldest.row.text, MAX_PREVIEW_CHARS);
  return `unread=${unread}, oldest unread ${formatAge(nowMs - oldest.at)} from ${sender}${
    preview ? ` ("${preview}")` : ''
  }`;
}

function latestEventAt(task, predicate) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) return events[index].timestamp;
  }
  return undefined;
}

function latestActionBy(task, actorName) {
  const actorKey = normalizeKey(actorName);
  const stamps = [];
  for (const comment of Array.isArray(task.comments) ? task.comments : []) {
    if (normalizeKey(comment && comment.author) === actorKey) stamps.push(comment.createdAt);
  }
  for (const event of Array.isArray(task.historyEvents) ? task.historyEvents : []) {
    if (normalizeKey(event && event.actor) === actorKey) stamps.push(event.timestamp);
  }
  const times = stamps.map((stamp) => Date.parse(normalizeName(stamp))).filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

function describeTaskAges(item, nowMs, memberKey) {
  const task = item._fullTask || {};
  const ages = [];
  const isOwner = normalizeKey(item.owner) === memberKey;
  const isReviewer = normalizeKey(item.reviewer) === memberKey;

  if (item.reviewState === 'review') {
    const since = ageSince(
      latestEventAt(task, (event) => event.type === 'review_started' || event.type === 'review_requested'),
      nowMs
    );
    if (since) ages.push(`in review ${since}`);
  } else if (item.reviewState === 'needsFix') {
    const since = ageSince(
      latestEventAt(task, (event) => event.type === 'review_changes_requested'),
      nowMs
    );
    if (since) ages.push(`changes requested ${since} ago`);
  } else if (item.status === 'in_progress') {
    const intervals = Array.isArray(task.workIntervals) ? task.workIntervals : [];
    const open = intervals.length > 0 ? intervals[intervals.length - 1] : null;
    const startedAt =
      open && open.completedAt === undefined
        ? open.startedAt
        : latestEventAt(task, (event) => event.type === 'status_changed' && event.to === 'in_progress');
    const since = ageSince(startedAt, nowMs);
    if (since) ages.push(`started ${since} ago`);
  } else if (item.status === 'pending') {
    const assignedAt =
      latestEventAt(task, (event) => event.type === 'owner_changed' && normalizeKey(event.to) === memberKey) ||
      task.createdAt;
    const since = ageSince(assignedAt, nowMs);
    if (since) ages.push(`not started, assigned ${since} ago`);
  }

  const actorRole = isOwner ? 'owner' : isReviewer ? 'reviewer' : null;
  if (actorRole) {
    const lastAction = latestActionBy(task, isOwner ? item.owner : item.reviewer);
    ages.push(
      lastAction == null
        ? `no ${actorRole} action yet`
        : `last ${actorRole} action ${formatAge(nowMs - lastAction)} ago`
    );
  }
  return ages;
}

function describeTaskLines(memberName, items, nowMs) {
  const memberKey = normalizeKey(memberName);
  const actionable = [];
  const watching = [];
  for (const item of items) {
    if (item.actionOwner.kind === 'member' && normalizeKey(item.actionOwner.memberName) === memberKey) {
      actionable.push(item);
    } else if (
      item.queueCategory !== 'done' &&
      (normalizeKey(item.owner) === memberKey ||
        normalizeKey(item.reviewer) === memberKey ||
        (Array.isArray(item.watchers) && item.watchers.some((entry) => normalizeKey(entry) === memberKey)))
    ) {
      watching.push(item);
    }
  }

  const lines = [];
  const addGroup = (group, kind, suffix, limit) => {
    for (const item of group.slice(0, limit)) {
      lines.push(`  ${agenda.formatAgendaLine(item, describeTaskAges(item, nowMs, memberKey))}${suffix}`);
    }
    if (group.length > limit) {
      lines.push(
        `  ... ${group.length - limit} more ${kind} task(s) omitted. Use task_list with the owner filter.`
      );
    }
  };
  addGroup(actionable, 'actionable', '', MAX_ACTIONABLE_LINES);
  addGroup(watching, 'watched', ' [watching]', MAX_WATCHING_LINES);
  return { actionableCount: actionable.length, watchingCount: watching.length, lines };
}

/**
 * Lines of the "Members" section; the caller places them in the briefing text.
 */
async function buildMembersSectionLines(context) {
  const { paths, teamName } = context;
  const nowMs = Date.now();
  const { names, leadKey } = listRosterNames(paths);
  if (names.length === 0) return [];

  const diagnostics = await readAppDiagnostics(context);
  const { items } = agenda.listAgendaItems(paths, teamName);

  const lines = [
    'Members (liveness from the app, unread from inboxes, task ages from the board):',
  ];
  if (diagnostics.unavailableReason) {
    lines.push(
      `App liveness: no data (${diagnostics.unavailableReason}). Unread counts and task ages below come from files and stay valid.`
    );
  }
  for (const name of names) {
    const isLead = normalizeKey(name) === leadKey;
    const head = [describeLiveness(diagnostics, name, nowMs), describeInbox(paths, name, nowMs)];
    if (isLead) {
      lines.push(`- ${name}: ${head.join('; ')}; (lead) its tasks are in the sections above`);
      continue;
    }
    const tasks = describeTaskLines(name, items, nowMs);
    head.push(`tasks=${tasks.actionableCount}`);
    if (tasks.watchingCount > 0) head.push(`watching=${tasks.watchingCount}`);
    lines.push(`- ${name}: ${head.join('; ')}`, ...tasks.lines);
  }
  return lines;
}

module.exports = {
  buildMembersSectionLines,
  formatAge,
};
