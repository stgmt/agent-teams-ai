import type { TaskArtifactFile, TaskFieldUpdates } from '@shared/types';

type ArtifactFields = Pick<
  TaskFieldUpdates,
  'artifactRequired' | 'artifactExpectedFilename' | 'artifactFile'
>;
const MAX_BASE64_CHARS = Math.ceil((20 * 1024 * 1024) / 3) * 4;

export function validateTaskArtifactFields(
  input: Record<string, unknown>
):
  | { valid: true; value: ArtifactFields; expectedContext: unknown }
  | { valid: false; error: string } {
  const { artifactRequired, artifactExpectedFilename, artifactFile } = input;
  if (input.artifactProjectPath !== undefined) {
    return { valid: false, error: 'Project paths are not supported; send artifact file bytes' };
  }
  if (artifactRequired !== undefined && typeof artifactRequired !== 'boolean') {
    return { valid: false, error: 'artifactRequired must be a boolean' };
  }
  if (
    artifactExpectedFilename !== undefined &&
    (typeof artifactExpectedFilename !== 'string' || artifactExpectedFilename.length > 255)
  ) {
    return { valid: false, error: 'artifactExpectedFilename must be a filename' };
  }
  if (artifactFile !== undefined) {
    if (!artifactFile || typeof artifactFile !== 'object')
      return { valid: false, error: 'artifactFile must contain filename and base64Data' };
    const file = artifactFile as Record<string, unknown>;
    if (
      typeof file.filename !== 'string' ||
      file.filename.length > 255 ||
      typeof file.base64Data !== 'string' ||
      file.base64Data.length > MAX_BASE64_CHARS
    ) {
      return {
        valid: false,
        error: 'artifactFile must contain a filename and at most 20 MiB of base64 data',
      };
    }
  }
  return {
    valid: true,
    expectedContext: input.artifactExpectedContext,
    value: {
      ...(artifactRequired !== undefined ? { artifactRequired } : {}),
      ...(artifactExpectedFilename !== undefined ? { artifactExpectedFilename } : {}),
      ...(artifactFile !== undefined ? { artifactFile: artifactFile as TaskArtifactFile } : {}),
    },
  };
}
