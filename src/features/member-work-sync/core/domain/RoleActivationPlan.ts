import { isLeadMember, isLeadNameAlias } from '@shared/utils/leadDetection';
import {
  getTeamTaskWorkflowColumn,
  isTeamTaskTerminalForActionableWork,
} from '@shared/utils/teamTaskState';

import {
  collectActionableWorkItems,
  type MemberWorkSyncMemberLike,
  type MemberWorkSyncTaskLike,
} from './ActionableWorkAgenda';
import { resolveCurrentReviewCycle } from './currentReviewCycle';
import { normalizeMemberName, sameMemberName } from './memberName';

export type RoleRuntimeState = 'running' | 'stopped' | 'unknown';
export type RolePlanReason =
  | 'team_unavailable'
  | 'runtime_unknown'
  | 'capacity_unknown'
  | 'capacity_limit'
  | 'owner_missing'
  | 'reviewer_missing'
  | 'reviewer_conflict'
  | 'self_review'
  | 'member_missing'
  | 'member_ambiguous'
  | 'task_not_actionable'
  | 'already_working'
  | 'already_reviewing'
  | 'member_busy'
  | 'workload_unknown'
  | 'member_already_planned'
  | 'availability_unknown'
  | 'availability_blocked';

export interface RolePlanMember extends MemberWorkSyncMemberLike {
  role?: string;
  runtime: RoleRuntimeState;
  currentTaskId?: string | null;
  busy?: boolean;
  workloadUnknown?: boolean;
  /** Explicit user assertion for this snapshot; not evidence of provider quota. */
  availabilityConfirmed: boolean;
  availabilityBlocked: boolean;
}

export interface RoleActivationPlanInput {
  teamName: string;
  teamAlive: boolean;
  runtimeSnapshotTrusted: boolean;
  runningRuntimeMembers: readonly string[];
  leadRuntimeMembers?: readonly string[];
  runtimeOccupancyUncertain?: boolean;
  maxConcurrentRoles: number;
  members: RolePlanMember[];
  tasks: MemberWorkSyncTaskLike[];
  kanbanReviewersByTaskId?: Record<string, string | null | undefined>;
}

export interface RolePlanRow {
  taskId: string;
  displayId?: string;
  subject: string;
  kind: 'work' | 'review';
  memberName: string | null;
  decision: 'recommend' | 'defer';
  reason?: RolePlanReason;
  /** A running role already occupies a slot; a stopped role would need a new one. */
  usesExistingSlot?: boolean;
}

export interface RoleActivationPlan {
  maxConcurrentRoles: number;
  runningRoles: number;
  projectedRoles: number;
  capacityUncertain: boolean;
  rows: RolePlanRow[];
}

/** Read-only recommendations from the same task/review rules used by work sync.
 * A running session is not proof of model quota. Availability must be explicitly
 * confirmed by the user for the currently displayed runtime snapshot.
 */
export function planRoleActivation(input: RoleActivationPlanInput): RoleActivationPlan {
  if (!Number.isSafeInteger(input.maxConcurrentRoles) || input.maxConcurrentRoles < 1) {
    throw new RangeError('Role limit must be a positive integer');
  }
  const activeMembers = input.members.filter((member) => !member.removedAt);
  const leadNames = new Set([
    ...activeMembers.filter(isLeadMember).map((member) => normalizeMemberName(member.name)),
    ...(input.leadRuntimeMembers ?? []).map(normalizeMemberName),
  ]);
  const roleKey = (name: string): string => {
    const key = normalizeMemberName(name);
    return leadNames.has(key) || isLeadNameAlias(name) ? '__lead__' : key;
  };
  // Distinct runtime entries can be separate processes even if their names are
  // lead aliases. Count them separately; collapsing aliases can undercount.
  const runningKeys = new Set(input.runningRuntimeMembers.map(normalizeMemberName).filter(Boolean));
  const leadMissing =
    input.teamAlive && !input.runningRuntimeMembers.some((name) => roleKey(name) === '__lead__');
  if (leadMissing) runningKeys.add('__unobserved_lead__');
  const runningRoles = runningKeys.size;
  const capacityUncertain =
    !input.runtimeSnapshotTrusted ||
    input.runtimeOccupancyUncertain === true ||
    leadMissing ||
    activeMembers.some((member) => member.runtime === 'unknown');
  const membersByName = new Map<string, RolePlanMember[]>();
  for (const member of activeMembers) {
    const key = normalizeMemberName(member.name);
    if (!key) continue;
    const matches = membersByName.get(key) ?? [];
    matches.push(member);
    membersByName.set(key, matches);
  }

  const candidates = new Map<string, { memberName: string; kind: 'work' | 'review' }>();
  for (const member of activeMembers) {
    const { items } = collectActionableWorkItems({
      memberName: member.name,
      members: activeMembers,
      tasks: input.tasks,
      kanbanReviewersByTaskId: input.kanbanReviewersByTaskId,
    });
    for (const item of items) {
      if ((item.kind === 'work' || item.kind === 'review') && !candidates.has(item.taskId)) {
        candidates.set(item.taskId, { memberName: member.name, kind: item.kind });
      }
    }
  }

  let projectedRoles = runningRoles;
  const plannedMembers = new Set<string>();
  const rows: RolePlanRow[] = [];
  for (const task of input.tasks) {
    const column = getTeamTaskWorkflowColumn(task);
    if (!task.id || (isTeamTaskTerminalForActionableWork(task) && column !== 'review')) continue;
    const kind = column === 'review' ? 'review' : 'work';
    const cycle =
      kind === 'review'
        ? resolveCurrentReviewCycle({
            reviewState: column,
            kanbanReviewer: input.kanbanReviewersByTaskId?.[task.id] ?? null,
            historyEvents: task.historyEvents,
          })
        : null;
    const assignee = kind === 'review' ? (cycle?.reviewer ?? null) : task.owner?.trim() || null;
    const base: RolePlanRow = {
      taskId: task.id,
      ...(task.displayId ? { displayId: task.displayId } : {}),
      subject: task.subject?.trim() || task.id,
      kind,
      memberName: assignee,
      decision: 'defer',
    };
    const defer = (reason: RolePlanReason): void => {
      rows.push({ ...base, reason });
    };
    const reviewerConflict = cycle?.diagnostics.some((diagnostic) =>
      [
        'review_started_actor_differs_from_requested_reviewer',
        'kanban_reviewer_differs_from_review_request',
        'kanban_reviewer_differs_from_review_started_actor',
      ].includes(diagnostic)
    );
    if (reviewerConflict) {
      rows.push({ ...base, memberName: null, reason: 'reviewer_conflict' });
      continue;
    }
    if (kind === 'review' && !task.owner?.trim()) {
      defer('owner_missing');
      continue;
    }
    if (!assignee) {
      defer(kind === 'review' ? 'reviewer_missing' : 'owner_missing');
      continue;
    }
    if (kind === 'review' && task.owner && roleKey(task.owner) === roleKey(assignee)) {
      defer('self_review');
      continue;
    }
    const matches = membersByName.get(normalizeMemberName(assignee)) ?? [];
    if (!matches.length) {
      defer('member_missing');
      continue;
    }
    if (matches.length !== 1) {
      defer('member_ambiguous');
      continue;
    }
    const member = matches[0];
    const candidate = candidates.get(task.id);
    if (
      !candidate ||
      !sameMemberName(candidate.memberName, member.name) ||
      candidate.kind !== kind
    ) {
      defer('task_not_actionable');
      continue;
    }
    if (kind === 'work' && task.status === 'in_progress') {
      defer('already_working');
      continue;
    }
    if (cycle?.obligation === 'review_in_progress') {
      defer('already_reviewing');
      continue;
    }
    if (!input.teamAlive) {
      defer('team_unavailable');
      continue;
    }
    if (!input.runtimeSnapshotTrusted || member.runtime === 'unknown') {
      defer('runtime_unknown');
      continue;
    }
    if (member.availabilityBlocked) {
      defer('availability_blocked');
      continue;
    }
    if (!member.availabilityConfirmed) {
      defer('availability_unknown');
      continue;
    }
    if (member.currentTaskId || member.busy) {
      defer('member_busy');
      continue;
    }
    if (member.runtime === 'running' && member.workloadUnknown) {
      defer('workload_unknown');
      continue;
    }
    const key = roleKey(member.name);
    if (plannedMembers.has(key)) {
      defer('member_already_planned');
      continue;
    }
    const usesExistingSlot = member.runtime === 'running';
    if (!usesExistingSlot && capacityUncertain) {
      defer('capacity_unknown');
      continue;
    }
    if (!usesExistingSlot && projectedRoles >= input.maxConcurrentRoles) {
      defer('capacity_limit');
      continue;
    }
    if (!usesExistingSlot) projectedRoles++;
    plannedMembers.add(key);
    rows.push({ ...base, decision: 'recommend', usesExistingSlot });
  }
  return {
    maxConcurrentRoles: input.maxConcurrentRoles,
    runningRoles,
    projectedRoles,
    capacityUncertain,
    rows,
  };
}
