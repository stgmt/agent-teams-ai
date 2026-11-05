// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createLeadReportingFeature } from '../../../src/features/lead-reporting/main';
import { MemberLifecycleRegistry } from '../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

const run = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
  teamName: 'test-reporting',
  runId: 'test-run',
};
const stamp = { source: 'test-source', revision: '1', observedAt: '2026-10-29T00:00:00Z' };

function setup() {
  let id = 0;
  let now = Date.parse(stamp.observedAt);
  const registry = new MemberLifecycleRegistry(run);
  registry.configureTeam(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'worker', role: 'member' },
  ]);
  const roster = vi.fn(() =>
    Promise.resolve({
      source: stamp,
      members: [
        { name: 'team-lead', role: 'lead' as const },
        { name: 'worker', role: 'member' as const },
      ],
    })
  );
  const lifecycle = vi.fn(() => Promise.resolve(registry.snapshot(run.teamName)));
  const feature = createLeadReportingFeature({
    sources: {
      roster,
      lifecycle,
      tasks: () => Promise.resolve({ source: stamp, tasks: [] }),
      results: () => Promise.resolve({ source: stamp, evidence: [] }),
    },
    resolveLead: () => run,
    now: () => new Date(now).toISOString(),
    newId: () => `test-${++id}`,
    fingerprint: (value) => value,
    maxInspectionAgeMs: 60_000,
    maxSourceWaitMs: 5_000,
    delivery: { deliver: ({ messageId }) => Promise.resolve({ messageId }), delivered: vi.fn() },
  });
  return {
    feature,
    roster,
    lifecycle,
    advance: () => {
      now += 60_001;
    },
  };
}

describe('inspection freshness across asynchronous source reads', () => {
  it('does not issue a receipt for a roster that changed while facts were being read', async () => {
    const { feature, roster } = setup();
    const operation = feature.begin({
      run,
      requestMessageId: 'test-request',
      scope: { kind: 'team' },
    });
    const original = await roster();
    roster.mockResolvedValueOnce(original).mockResolvedValueOnce({
      ...original,
      source: { ...stamp, revision: '2' },
      members: [
        { name: 'team-lead', role: 'lead' as const },
        { name: 'replacement', role: 'member' as const },
      ],
    });
    await expect(feature.inspect('test', operation.reportRunId)).rejects.toThrow('roster changed');
  });

  it('does not renew old facts by timestamping them after a slow source read', async () => {
    const { feature, lifecycle, advance } = setup();
    const operation = feature.begin({
      run,
      requestMessageId: 'test-request',
      scope: { kind: 'team' },
    });
    const original = await lifecycle();
    lifecycle.mockImplementationOnce(() => {
      advance();
      return Promise.resolve(original);
    });
    const inspection = await feature.inspect('test', operation.reportRunId);
    expect(inspection.observedAt).toBe(new Date(stamp.observedAt).toISOString());
    await expect(
      feature.publish('test', {
        inspectionId: inspection.inspectionId,
        summary: 'No work assigned.',
        nextStep: 'Inspect again before reporting.',
        members: [
          {
            memberName: 'worker',
            statements: [
              { kind: 'observation', text: 'No assigned work.', evidenceIds: ['process:worker'] },
            ],
          },
        ],
      })
    ).rejects.toThrow('expired');
  });

  it('checks age after source revalidation too, before publication', async () => {
    const { feature, roster, advance } = setup();
    const operation = feature.begin({
      run,
      requestMessageId: 'test-request',
      scope: { kind: 'team' },
    });
    const inspection = await feature.inspect('test', operation.reportRunId);
    const original = await roster();
    roster.mockImplementationOnce(() => {
      advance();
      return Promise.resolve(original);
    });
    await expect(
      feature.publish('test', {
        inspectionId: inspection.inspectionId,
        summary: 'No work assigned.',
        nextStep: 'Assign work when requested.',
        members: [
          {
            memberName: 'worker',
            statements: [
              { kind: 'observation', text: 'No assigned work.', evidenceIds: ['process:worker'] },
            ],
          },
        ],
      })
    ).rejects.toThrow('expired');
  });
});
