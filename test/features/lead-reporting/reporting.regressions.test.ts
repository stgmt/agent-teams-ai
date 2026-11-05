// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createLeadReportingFeature } from '../../../src/features/lead-reporting/main';
import { MemberLifecycleRegistry } from '../../../src/features/team-provisioning/core/domain/MemberLifecycleRegistry';

import type { LeadReportDraft } from '../../../src/features/lead-reporting/contracts';

const run = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
  teamName: 'test-reports',
  runId: 'test-run',
};
const source = {
  source: 'test-source',
  revision: 'test-revision',
  observedAt: '2026-10-29T00:00:00.000Z',
};

function setup() {
  let id = 0;
  const registry = new MemberLifecycleRegistry(run);
  registry.configureTeam(run, [
    { memberName: 'team-lead', role: 'lead' },
    { memberName: 'worker', role: 'member' },
    { memberName: 'other', role: 'member' },
  ]);
  const delivery = {
    deliver: vi.fn((input: { messageId: string }) =>
      Promise.resolve({ messageId: input.messageId })
    ),
    delivered: vi.fn(),
  };
  const lifecycle = vi.fn(() => Promise.resolve(registry.snapshot(run.teamName)));
  const feature = createLeadReportingFeature({
    newId: () => `test-${++id}`,
    fingerprint: (value) => value,
    now: () => source.observedAt,
    maxInspectionAgeMs: 60_000,
    maxSourceWaitMs: 5_000,
    resolveLead: () => run,
    delivery,
    sources: {
      roster: () =>
        Promise.resolve({
          source,
          members: [
            { name: 'team-lead', role: 'lead' },
            { name: 'worker', role: 'member' },
            { name: 'other', role: 'member' },
          ],
        }),
      lifecycle,
      tasks: () => Promise.resolve({ source, tasks: [] }),
      results: () => Promise.resolve({ source, evidence: [] }),
    },
  });
  const begin = (requestMessageId: string) =>
    feature.begin({ run, requestMessageId, scope: { kind: 'members', memberNames: ['worker'] } });
  return { feature, registry, delivery, begin, lifecycle };
}

function draft(inspectionId: string): LeadReportDraft {
  return {
    inspectionId,
    summary: 'No assigned work is recorded.',
    nextStep: 'Assign the next requested task.',
    members: [
      {
        memberName: 'worker',
        statements: [
          {
            kind: 'observation',
            text: 'worker has no assigned tasks.',
            evidenceIds: ['process:worker'],
          },
        ],
      },
    ],
  };
}

describe('lead report operation boundaries', () => {
  it('does not turn management reads into report operations or make their facts publishable', async () => {
    const { feature, delivery } = setup();
    for (let index = 0; index < 201; index++) {
      const briefing = await feature.briefing('test');
      expect(briefing.kind).toBe('management');
      expect(briefing.inspection.run).toEqual(run);
      expect(briefing.inspection.members.map((member) => member.name)).toEqual(['other', 'worker']);
      expect(briefing.inspection).not.toHaveProperty('inspectionId');
      expect(briefing.inspection).not.toHaveProperty('reportRunId');
    }
    expect(feature.current('test')).toBeNull();
    await expect(feature.publish('test', draft('not-a-receipt'))).rejects.toThrow('receipt');
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('rejects management facts collected across admission of a human report request', async () => {
    const { feature, begin, lifecycle, registry } = setup();
    let finish!: (value: ReturnType<typeof registry.snapshot>) => void;
    lifecycle.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = feature.briefing('test');
    await Promise.resolve();
    await Promise.resolve();
    const operation = begin('new-human-request');
    finish(registry.snapshot(run.teamName));
    await expect(pending).rejects.toThrow('Human report request changed');
    const briefing = await feature.briefing('test');
    expect(briefing.kind).toBe('report');
    expect(briefing.inspection).toMatchObject({ reportRunId: operation.reportRunId });
  });

  it('rejects management facts even when a report admitted during collection finishes before that read', async () => {
    const { feature, begin, lifecycle, registry } = setup();
    let finish!: (value: ReturnType<typeof registry.snapshot>) => void;
    lifecycle.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = feature.briefing('test');
    await Promise.resolve();
    await Promise.resolve();
    const operation = begin('new-human-request');
    const inspection = await feature.inspect('test', operation.reportRunId);
    await feature.publish('test', draft(inspection.inspectionId));
    expect(feature.current('test')).toBeNull();
    finish(registry.snapshot(run.teamName));
    await expect(pending).rejects.toThrow('Human report request changed');
  });

  it('does not replace the active human report or publish its predecessor after admitting a successor', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test', operation.reportRunId);
    expect(() => begin('request-two')).toThrow('Previous report request is still active');
    expect(feature.current('test')).toEqual(operation);
    expect(begin('request-one')).toEqual(operation);
    delivery.delivered.mockImplementationOnce(() => {
      throw new Error('test-notification-failed');
    });
    await expect(feature.publish('test', draft(inspection.inspectionId))).rejects.toThrow(
      'test-notification-failed'
    );
    expect(() => begin('request-two')).toThrow('Previous report request is still active');
    await feature.publish('test', draft(inspection.inspectionId));
    const next = begin('request-two');
    expect(next.requestMessageId).toBe('request-two');
    expect(feature.current('test')).toEqual(next);
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
  });

  it('records recovered lifecycle evidence as a process change, not task progress', async () => {
    const { feature, begin, lifecycle } = setup();
    lifecycle.mockRejectedValue(new Error('test-unavailable'));
    const operation = begin('request-one');
    const unavailable = await feature.inspect('test', operation.reportRunId);
    await feature.publish('test', draft(unavailable.inspectionId));
    lifecycle.mockReset();
    // Recovery is a real source observation, not an old launch confirmation.
    const registry = new MemberLifecycleRegistry(run);
    registry.configureTeam(run, [
      { memberName: 'team-lead', role: 'lead' },
      { memberName: 'worker', role: 'member' },
    ]);
    lifecycle.mockImplementation(() => Promise.resolve(registry.snapshot(run.teamName)));
    const next = begin('request-two');
    const recovered = await feature.inspect('test', next.reportRunId);
    expect(recovered.sourceErrors).toEqual([]);
    expect(recovered.changesSinceLastReport).toEqual([
      { memberName: 'worker', areas: ['process'] },
    ]);
    expect(recovered.members[0].verifiedResults).toEqual([]);
  });

  it('rejects an inspection that finishes after another inspection was already published', async () => {
    const { feature, begin, lifecycle, registry } = setup();
    const operation = begin('request-one');
    const first = await feature.inspect('test', operation.reportRunId);
    let finish!: (value: ReturnType<typeof registry.snapshot>) => void;
    lifecycle.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = feature.inspect('test', operation.reportRunId);
    // Let the new inspection reach its suspended source read before publication revalidates.
    await Promise.resolve();
    await Promise.resolve();
    await feature.publish('test', draft(first.inspectionId));
    finish(registry.snapshot(run.teamName));
    await expect(pending).rejects.toThrow('changed during inspection');
    expect(feature.current('test')).toBeNull();
  });

  it('does not invent work progress when all inspected facts are unchanged', async () => {
    const { feature, begin } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test-credential', operation.reportRunId);
    await feature.publish('test-credential', draft(inspection.inspectionId));
    const next = begin('request-two');
    expect(
      (await feature.inspect('test-credential', next.reportRunId)).changesSinceLastReport
    ).toEqual([]);
  });

  it('ignores unrelated member lifecycle changes for a deliberately narrow report', async () => {
    const { feature, registry, begin } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test-credential', operation.reportRunId);
    const other = registry.beginTeamStart(run, () => 'test-operation')[2];
    // Both members start under the same transition; inspect again before only other changes.
    const current = await feature.inspect('test-credential', operation.reportRunId);
    registry.observeSpawn(other, { pid: 123, birthId: 'test-birth' });
    await expect(
      feature.publish('test-credential', draft(current.inspectionId))
    ).resolves.toMatchObject({ requestMessageId: 'request-one' });
    await expect(
      feature.publish('test-credential', draft(inspection.inspectionId))
    ).rejects.toThrow('inspection');
  });

  it('deduplicates concurrent publication and retries only notification after its failure', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test-credential', operation.reportRunId);
    delivery.delivered.mockImplementationOnce(() => {
      throw new Error('test-notification-failed');
    });
    await expect(
      feature.publish('test-credential', draft(inspection.inspectionId))
    ).rejects.toThrow('test-notification-failed');
    await Promise.all([
      feature.publish('test-credential', draft(inspection.inspectionId)),
      feature.publish('test-credential', draft(inspection.inspectionId)),
    ]);
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.delivered).toHaveBeenCalledTimes(2);
  });

  it('retains a confirmed delivery until its pending request closure succeeds, even at the operation limit', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test', operation.reportRunId);
    delivery.delivered.mockImplementationOnce(() => {
      throw new Error('test-notification-failed');
    });
    await expect(feature.publish('test', draft(inspection.inspectionId))).rejects.toThrow(
      'test-notification-failed'
    );
    for (let index = 1; index < 200; index++) {
      feature.begin({
        run: { ...run, runId: `other-run-${index}` },
        requestMessageId: `other-request-${index}`,
        scope: { kind: 'team' },
      });
    }
    expect(() =>
      feature.begin({
        run: { ...run, runId: 'over-limit-run' },
        requestMessageId: 'over-limit',
        scope: { kind: 'team' },
      })
    ).toThrow('Too many unfinished');
    await feature.publish('test', draft(inspection.inspectionId));
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.delivered).toHaveBeenCalledTimes(2);
    expect(() =>
      feature.begin({
        run: { ...run, runId: 'after-closure-run' },
        requestMessageId: 'after-closure',
        scope: { kind: 'team' },
      })
    ).not.toThrow();
    expect(feature.current('test')).toBeNull();
  });

  it('ends repeated report corrections with one app-owned limitation instead of an endless model loop', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test', operation.reportRunId);
    const invalid = { ...draft(inspection.inspectionId), members: [] };
    for (let index = 0; index < 4; index++)
      await expect(feature.publish('test', invalid)).rejects.toThrow('coverage');
    await expect(feature.publish('test', invalid)).rejects.toThrow(
      'limitation was already delivered'
    );
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        requestMessageId: 'request-one',
        text: expect.stringContaining('publication correction limit'),
      })
    );
    expect(feature.current('test')).toBeNull();
    await expect(feature.publish('test', invalid)).rejects.toThrow(
      'limitation was already delivered'
    );
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect((await feature.briefing('test')).kind).toBe('management');
    const next = begin('request-two');
    expect((await feature.inspect('test', next.reportRunId)).comparedToMessageId).toBeNull();
  });

  it('retries only the exact pending append after delivery starts, without renewing facts or replacing text', async () => {
    const { feature, begin, delivery, lifecycle } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test', operation.reportRunId);
    const report = draft(inspection.inspectionId);
    delivery.deliver.mockRejectedValueOnce(new Error('test-uncertain-append'));
    await expect(feature.publish('test', report)).rejects.toThrow('test-uncertain-append');
    lifecycle.mockRejectedValue(new Error('test-source-later-unavailable'));
    await expect(
      feature.publish('test', { ...report, summary: 'Different answer' })
    ).rejects.toThrow('Prepared report delivery cannot be replaced');
    await expect(feature.publish('test', report)).resolves.toMatchObject({
      requestMessageId: 'request-one',
    });
    expect(delivery.deliver).toHaveBeenCalledTimes(2);
    expect(delivery.deliver.mock.calls[0]).toEqual(delivery.deliver.mock.calls[1]);
    expect(delivery.delivered).toHaveBeenCalledTimes(1);
  });

  it('retains the same terminal limitation across an append failure and concurrent delivery retries', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    await feature.inspect('test', operation.reportRunId);
    await feature.inspect('test', operation.reportRunId);
    delivery.deliver.mockRejectedValueOnce(new Error('test-disk-failure'));
    await expect(feature.inspect('test', operation.reportRunId)).rejects.toThrow(
      'test-disk-failure'
    );
    expect(() => begin('request-two')).toThrow('Previous report request is still active');
    const retries = await Promise.allSettled([
      feature.inspect('test', operation.reportRunId),
      feature.inspect('test', operation.reportRunId),
    ]);
    expect(
      retries.every(
        (result) =>
          result.status === 'rejected' &&
          String(result.reason).includes('limitation was already delivered')
      )
    ).toBe(true);
    expect(delivery.deliver).toHaveBeenCalledTimes(2);
    expect(delivery.deliver.mock.calls[0]).toEqual(delivery.deliver.mock.calls[1]);
    expect(delivery.delivered).toHaveBeenCalledTimes(1);
    expect(feature.current('test')).toBeNull();
  });

  it('bounds reinspection and retries only pending delivery of its terminal limitation', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    await feature.inspect('test', operation.reportRunId);
    await feature.inspect('test', operation.reportRunId);
    delivery.delivered.mockImplementationOnce(() => {
      throw new Error('test-notification-failed');
    });
    await expect(feature.inspect('test', operation.reportRunId)).rejects.toThrow(
      'test-notification-failed'
    );
    expect(() => begin('request-two')).toThrow('Previous report request is still active');
    await expect(feature.inspect('test', operation.reportRunId)).rejects.toThrow(
      'limitation was already delivered'
    );
    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.delivered).toHaveBeenCalledTimes(2);
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('inspection attempt limit') })
    );
    expect(feature.current('test')).toBeNull();
    expect(begin('request-two').requestMessageId).toBe('request-two');
  });

  it('rejects a new inspection of an already delivered operation', async () => {
    const { feature, begin, delivery } = setup();
    const operation = begin('request-one');
    const inspection = await feature.inspect('test-credential', operation.reportRunId);
    await feature.publish('test-credential', draft(inspection.inspectionId));
    await expect(feature.inspect('test-credential', operation.reportRunId)).rejects.toThrow(
      'delivered'
    );
    expect(delivery.delivered).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ requestMessageId: 'request-one' })
    );
  });
});
