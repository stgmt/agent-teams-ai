// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { NativeRuntimeFailureObserver } from '../../../../src/features/team-provisioning/main/adapters/output/NativeRuntimeFailureObserver';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const snapshot: TeamLifecycleSnapshot = {
  identity: {
    appInstanceId: 'TEST-app',
    dataRootFingerprint: 'TEST-fingerprint',
    connectionGeneration: 1,
    teamName: 'alpha',
    runId: 'TEST-run',
  },
  desired: 'running',
  resources: 'held',
  state: 'ready',
  error: null,
  version: 4,
  startedAt: '2026-11-01T00:00:00.000Z',
  members: {},
};

describe('native runtime failure observer', () => {
  it('reports the failing member on the run the snapshot names, not one the caller claims', () => {
    const emit = vi.fn();
    const observer = new NativeRuntimeFailureObserver({
      emit,
      nowIso: () => '2026-11-02T06:00:00.000Z',
    });

    observer.report({
      snapshot,
      memberName: 'builder',
      phase: 'terminal',
      detail: 'provider rejected the model',
      providerId: 'opencode',
      model: 'opencode-go/deepseek',
    });

    expect(emit).toHaveBeenCalledWith({
      teamName: 'alpha',
      runId: 'TEST-run',
      memberName: 'builder',
      phase: 'terminal',
      detail: 'provider rejected the model',
      providerId: 'opencode',
      model: 'opencode-go/deepseek',
      observedAt: '2026-11-02T06:00:00.000Z',
    });
  });

  it('keeps retry details that let the app say when the next attempt happens', () => {
    const emit = vi.fn();
    const observer = new NativeRuntimeFailureObserver({
      emit,
      nowIso: () => '2026-11-02T06:00:00.000Z',
    });

    observer.report({
      snapshot,
      memberName: 'team-lead',
      phase: 'sdk_retrying',
      detail: 'rate limited',
      statusCode: 429,
      retryAfterMs: 5_000,
      runtimeSessionId: 'session-7',
    });

    expect(emit.mock.calls[0]![0]).toMatchObject({
      memberName: 'team-lead',
      phase: 'sdk_retrying',
      statusCode: 429,
      retryAfterMs: 5_000,
      runtimeSessionId: 'session-7',
    });
  });
});
