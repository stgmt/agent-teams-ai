import { BoundControlContext } from '@features/external-agent-connection/main/BoundControlContext';
import {
  configureArtifactAdmission,
  runArtifactBoundUpdate,
} from '@main/ipc/teams/artifactBoundAdmission';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('artifact mutation root admission', () => {
  afterEach(() => configureArtifactAdmission(undefined));

  it('drains an admitted write before root rebind and rejects the old expected context', async () => {
    const context = new BoundControlContext('TEST-app', 'root-a');
    configureArtifactAdmission(async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    });
    const expected = context.snapshot();
    let finish!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = runArtifactBoundUpdate({ artifactRequired: true }, expected, operation);
    let drained = false;
    const closing = context.closeAdmission().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await pending;
    await closing;
    context.rebind('root-b');
    await expect(
      runArtifactBoundUpdate({ artifactRequired: true }, expected, operation)
    ).rejects.toThrow(/APP_CONTEXT_MISMATCH/);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary fields unchanged and fails closed for missing admission/context', async () => {
    const operation = vi.fn(async () => undefined);
    await runArtifactBoundUpdate({ subject: 'ordinary change' }, undefined, operation);
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(
      runArtifactBoundUpdate({ artifactRequired: true }, undefined, operation)
    ).rejects.toThrow(/expected app context/);
    const context = new BoundControlContext('TEST-app', 'root-a').snapshot();
    await expect(
      runArtifactBoundUpdate({ artifactRequired: true }, context, operation)
    ).rejects.toThrow(/admission is unavailable/);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
