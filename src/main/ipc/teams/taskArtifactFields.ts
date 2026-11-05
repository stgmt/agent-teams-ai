import type { TaskFieldUpdates } from '@shared/types';

type ArtifactFields = Pick<TaskFieldUpdates, 'artifactRequired' | 'artifactProjectPath'>;

export function validateTaskArtifactFields(
  input: Record<string, unknown>
): { valid: true; value: ArtifactFields } | { valid: false; error: string } {
  const { artifactRequired, artifactProjectPath } = input;
  if (artifactRequired !== undefined && typeof artifactRequired !== 'boolean') {
    return { valid: false, error: 'artifactRequired must be a boolean' };
  }
  if (
    artifactProjectPath !== undefined &&
    (typeof artifactProjectPath !== 'string' || artifactProjectPath.length > 4096)
  ) {
    return { valid: false, error: 'artifactProjectPath must be a path under 4097 characters' };
  }
  return {
    valid: true,
    value: {
      ...(artifactRequired !== undefined ? { artifactRequired } : {}),
      ...(artifactProjectPath !== undefined ? { artifactProjectPath } : {}),
    },
  };
}
