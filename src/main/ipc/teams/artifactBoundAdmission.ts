import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TaskFieldUpdates } from '@shared/types';

export type ArtifactAdmission = <T>(
  expected: AppConnectionContext,
  expectedRootFingerprint: string,
  operation: () => Promise<T>
) => Promise<T>;
let admission: ArtifactAdmission | undefined;

export function hasArtifactFields(fields: TaskFieldUpdates): boolean {
  return (
    fields.artifactRequired !== undefined ||
    fields.artifactExpectedFilename !== undefined ||
    fields.artifactFile !== undefined
  );
}

export function configureArtifactAdmission(value?: ArtifactAdmission): void {
  admission = value;
}

export async function runArtifactBoundUpdate(
  fields: TaskFieldUpdates,
  binding: { expectedContext: unknown; expectedRootFingerprint: unknown },
  operation: () => Promise<void>
): Promise<void> {
  if (!hasArtifactFields(fields)) return operation();
  if (
    fields.subject !== undefined ||
    fields.description !== undefined ||
    fields.groupChatId !== undefined
  ) {
    throw new Error('Artifact updates must be submitted separately from other task fields');
  }
  const expected = binding.expectedContext;
  if (!expected || typeof expected !== 'object')
    throw new Error('Artifact update requires the expected app context');
  const context = expected as Partial<AppConnectionContext>;
  if (
    typeof context.appInstanceId !== 'string' ||
    !context.appInstanceId ||
    typeof context.dataRootFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(context.dataRootFingerprint) ||
    !Number.isSafeInteger(context.connectionGeneration) ||
    (context.connectionGeneration ?? 0) < 1
  ) {
    throw new Error('Artifact update requires a valid expected app context');
  }
  if (!admission) throw new Error('Artifact context admission is unavailable');
  if (
    typeof binding.expectedRootFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(binding.expectedRootFingerprint)
  )
    throw new Error('Artifact update requires a valid physical root fingerprint');
  return admission(context as AppConnectionContext, binding.expectedRootFingerprint, operation);
}
