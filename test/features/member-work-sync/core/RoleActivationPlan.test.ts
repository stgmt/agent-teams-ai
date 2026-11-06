import {
  planRoleActivation,
  type RoleActivationPlanInput,
  type RolePlanMember,
} from '@features/member-work-sync/core/domain/RoleActivationPlan';
import { describe, expect, it } from 'vitest';

const member = (
  name: string,
  runtime: RolePlanMember['runtime'],
  overrides: Partial<RolePlanMember> = {}
): RolePlanMember => ({
  name,
  runtime,
  availabilityConfirmed: true,
  availabilityBlocked: false,
  ...overrides,
});
const base = (overrides: Partial<RoleActivationPlanInput> = {}): RoleActivationPlanInput => ({
  teamName: 'team',
  teamAlive: true,
  runtimeSnapshotTrusted: true,
  runningRuntimeMembers: ['team-lead', 'active'],
  maxConcurrentRoles: 3,
  members: [
    member('team-lead', 'running', { agentType: 'team-lead' }),
    member('active', 'running'),
    member('first', 'stopped'),
    member('second', 'stopped'),
  ],
  tasks: [
    { id: '1', status: 'pending', owner: 'first' },
    { id: '2', status: 'pending', owner: 'second' },
  ],
  ...overrides,
});

describe('role activation recommendations', () => {
  it('counts the live lead and running teammates and reserves a slot per proposed activation', () => {
    const plan = planRoleActivation(base());
    expect(plan.runningRoles).toBe(2);
    expect(plan.projectedRoles).toBe(3);
    expect(plan.rows.map((row) => [row.taskId, row.decision, row.reason])).toEqual([
      ['1', 'recommend', undefined],
      ['2', 'defer', 'capacity_limit'],
    ]);
  });

  it('can suggest work for an already running idle member without allocating a new slot', () => {
    const plan = planRoleActivation(
      base({ maxConcurrentRoles: 2, tasks: [{ id: '1', status: 'pending', owner: 'active' }] })
    );
    expect(plan.projectedRoles).toBe(2);
    expect(plan.rows[0]).toMatchObject({ decision: 'recommend', usesExistingSlot: true });
  });

  it('never treats unknown provider availability, an untrusted runtime, or unknown occupancy as available', () => {
    expect(
      planRoleActivation(
        base({
          members: base().members.map((m) =>
            m.name === 'first' ? { ...m, availabilityConfirmed: false } : m
          ),
        })
      ).rows[0].reason
    ).toBe('availability_unknown');
    expect(planRoleActivation(base({ runtimeSnapshotTrusted: false })).rows[0].reason).toBe(
      'runtime_unknown'
    );
    expect(
      planRoleActivation(base({ members: [...base().members, member('unknown', 'unknown')] }))
        .rows[0].reason
    ).toBe('capacity_unknown');
    expect(
      planRoleActivation(
        base({
          members: base().members.map((m) =>
            m.name === 'first' ? { ...m, availabilityBlocked: true } : m
          ),
        })
      ).rows[0].reason
    ).toBe('availability_blocked');
  });

  it('does not recommend the task owner as the reviewer, including case differences', () => {
    const plan = planRoleActivation(
      base({
        tasks: [{ id: '1', status: 'completed', reviewState: 'review', owner: 'first' }],
        kanbanReviewersByTaskId: { '1': 'FIRST' },
      })
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ decision: 'defer', reason: 'self_review' });
  });

  it('counts a custom-named runtime lead and recognizes lead aliases for self-review', () => {
    const plan = planRoleActivation(
      base({
        runningRuntimeMembers: ['CEO', 'active'],
        leadRuntimeMembers: ['CEO'],
        members: [member('CEO', 'running', { agentType: 'lead' }), ...base().members.slice(1)],
        tasks: [{ id: '1', status: 'completed', reviewState: 'review', owner: 'CEO' }],
        kanbanReviewersByTaskId: { '1': 'team-lead' },
      })
    );
    expect(plan.runningRoles).toBe(2);
    expect(plan.rows[0].reason).toBe('self_review');
  });

  it('does not collapse distinct live runtime entries even when both look like lead aliases', () => {
    const plan = planRoleActivation(
      base({
        runningRuntimeMembers: ['CEO', 'team-lead', 'active'],
        leadRuntimeMembers: ['CEO'],
      })
    );
    expect(plan.runningRoles).toBe(3);
    expect(plan.rows[0].reason).toBe('capacity_limit');
  });

  it('defers new roles when occupancy or the lead is uncertain and validates the limit', () => {
    expect(planRoleActivation(base({ runtimeOccupancyUncertain: true })).rows[0].reason).toBe(
      'capacity_unknown'
    );
    const missingLead = planRoleActivation(base({ runningRuntimeMembers: ['active'] }));
    expect(missingLead.runningRoles).toBe(2);
    expect(missingLead.rows[0].reason).toBe('capacity_unknown');
    expect(() => planRoleActivation(base({ maxConcurrentRoles: 0 }))).toThrow(RangeError);
  });

  it('defers busy members, unknown workload, missing owners and ambiguous roster names', () => {
    const activeTask = [{ id: '1', status: 'pending', owner: 'active' }];
    const withActive = (overrides: Partial<RolePlanMember>) =>
      base({
        tasks: activeTask,
        members: base().members.map((m) => (m.name === 'active' ? { ...m, ...overrides } : m)),
      });
    expect(planRoleActivation(withActive({ busy: true })).rows[0].reason).toBe('member_busy');
    expect(planRoleActivation(withActive({ workloadUnknown: true })).rows[0].reason).toBe(
      'workload_unknown'
    );
    expect(
      planRoleActivation(base({ tasks: [{ id: '1', status: 'pending' }] })).rows[0].reason
    ).toBe('owner_missing');
    expect(
      planRoleActivation(base({ members: [...base().members, member('FIRST', 'stopped')] })).rows[0]
        .reason
    ).toBe('member_ambiguous');
  });

  it('uses the existing review-cycle and dependency rules', () => {
    const plan = planRoleActivation(
      base({
        tasks: [
          { id: 'dep', status: 'pending', owner: 'active' },
          { id: '1', status: 'pending', owner: 'first', blockedBy: ['dep'] },
          {
            id: '2',
            status: 'completed',
            reviewState: 'review',
            owner: 'active',
            historyEvents: [{ id: 'review-request', type: 'review_requested', reviewer: 'second' }],
          },
        ],
        kanbanReviewersByTaskId: { '2': 'second' },
      })
    );
    expect(plan.rows.find((row) => row.taskId === '1')).toMatchObject({
      decision: 'defer',
      reason: 'task_not_actionable',
    });
    expect(plan.rows.find((row) => row.taskId === '2')).toMatchObject({
      decision: 'recommend',
      kind: 'review',
      memberName: 'second',
    });
  });

  it('defers review when its requested reviewer conflicts with the Kanban reviewer', () => {
    const plan = planRoleActivation(
      base({
        tasks: [
          {
            id: '1',
            status: 'completed',
            reviewState: 'review',
            owner: 'active',
            historyEvents: [{ id: 'request', type: 'review_requested', reviewer: 'first' }],
          },
        ],
        kanbanReviewersByTaskId: { '1': 'second' },
      })
    );
    expect(plan.rows[0]).toMatchObject({
      decision: 'defer',
      reason: 'reviewer_conflict',
      memberName: null,
    });
  });

  it('does not suggest starting an existing or unconfirmed review again', () => {
    const task = { id: '1', status: 'completed', reviewState: 'review', owner: 'active' };
    const started = {
      ...task,
      historyEvents: [
        { id: 'request', type: 'review_requested', reviewer: 'second' },
        { id: 'started', type: 'review_started', actor: 'second' },
      ],
    };
    for (const review of [task, started]) {
      const plan = planRoleActivation(
        base({ tasks: [review], kanbanReviewersByTaskId: { '1': 'second' } })
      );
      expect(plan.rows[0]).toMatchObject({ decision: 'defer', reason: 'already_reviewing' });
    }
  });

  it('does not assign multiple tasks to one role or infer that an inactive team can run', () => {
    const tasks = [
      { id: '1', status: 'pending', owner: 'first' },
      { id: '2', status: 'pending', owner: 'first' },
    ];
    const plan = planRoleActivation(base({ tasks }));
    expect(plan.rows[0].decision).toBe('recommend');
    expect(plan.rows[1].reason).toBe('member_already_planned');
    expect(
      planRoleActivation(base({ tasks, teamAlive: false })).rows.every(
        (row) => row.reason === 'team_unavailable'
      )
    ).toBe(true);
  });
});
