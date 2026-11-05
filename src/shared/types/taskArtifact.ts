import type { AttachmentMediaType } from '@features/agent-attachments/contracts';

/** Metadata for an attachment associated with a task or comment. */
export interface TaskAttachmentMeta {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  size: number;
  addedAt: string;
  /** Absolute path when applicable; absent for project-relative references. */
  filePath?: string | null;
}

export interface TaskArtifactProof {
  attachmentId: string;
  sha256: string;
  size: number;
}

export interface TaskArtifactRequirement {
  required: boolean;
  expectedFilename?: string;
  proof?: TaskArtifactProof;
}

export interface TaskArtifactFile {
  filename: string;
  base64Data: string;
}
