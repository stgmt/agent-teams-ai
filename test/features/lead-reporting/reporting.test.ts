// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createLeadReportingFeature } from '../../../src/features/lead-reporting/main';
import { MemberLifecycleRegistry } from '../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

import type { LeadReportDraft } from '../../../src/features/lead-reporting/contracts';
import type { LeadReportDependencies } from '../../../src/features/lead-reporting/core/application/ports';

const run = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
  teamName: 'test-reporting',
  runId: 'test-run',
};
const stamp = { source: 'test-board', revision: '1', observedAt: '2026-10-29T00:00:00.000Z' };

function setup() {
  let id = 0;
  let now = Date.parse(stamp.observedAt);
  const registry = new MemberLifecycleRegistry(run);
  registry.configureTeam(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'builder', role: 'member' },
    { memberName: 'free', role: 'member' },
    { memberName: 'unknown', role: 'member' },
  ]);
  const deps: LeadReportDependencies = {
    resolveLead: (credential) => {
      if (credential !== 'test-credential') throw new Error('Unauthorized');
      return run;
    },
    now: () => new Date(now).toISOString(),
    newId: () => `test-id-${++id}`,
    maxInspectionAgeMs: 60_000,
    sources: {
      roster: vi.fn(() =>
        Promise.resolve({
          source: { ...stamp, source: 'roster' },
          members: [
            { name: 'team-lead', role: 'lead' as const },
            { name: 'builder', role: 'member' as const },
            { name: 'free', role: 'member' as const },
            { name: 'unknown', role: 'member' as const },
          ],
        })
      ),
      lifecycle: vi.fn(() => Promise.resolve(registry.snapshot(run.teamName))),
      tasks: vi.fn(() =>
        Promise.resolve({
          source: stamp,
          tasks: [
            {
              memberName: 'builder',
              taskId: 'test-task',
              subject: 'Finish checkout',
              status: 'in_progress',
              source: stamp,
              evidence: [
                {
                  evidenceId: 'work-1',
                  memberName: 'builder',
                  taskId: 'test-task',
                  source: stamp,
                  locator: 'task:test-task',
                  topic: 'work' as const,
                  verification: 'observed' as const,
                  description: 'Task is in progress; no completed result recorded',
                  occurredAt: null,
                },
              ],
            },
          ],
        })
      ),
      results: vi.fn(() =>
        Promise.resolve({ source: { ...stamp, source: 'results' }, evidence: [] })
      ),
    },
    delivery: {
      deliver: vi.fn((input) => Promise.resolve({ messageId: input.messageId })),
      delivered: vi.fn(),
    },
  };
  const feature = createLeadReportingFeature(deps);
  const operation = feature.begin({
    run,
    requestMessageId: 'test-request',
    scope: { kind: 'team' },
  });
  return {
    feature,
    operation,
    deps,
    registry,
    advance: () => {
      now += 60_001;
    },
  };
}

function draft(
  inspection: Awaited<ReturnType<ReturnType<typeof setup>['feature']['inspect']>>
): LeadReportDraft {
  return {
    inspectionId: inspection.inspectionId,
    summary: 'Checkout is not finished.',
    nextStep: 'Review the unfinished checkout task.',
    members: inspection.members.map((member) => ({
      memberName: member.name,
      statements: [
        {
          kind: 'observation' as const,
          text: member.tasks[0]?.subject ?? `${member.name}: no assigned tasks`,
          evidenceIds: [member.tasks[0]?.evidence[0]?.evidenceId ?? `process:${member.name}`],
        },
      ],
    })),
  };
}
