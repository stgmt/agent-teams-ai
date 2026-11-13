/**
 * Pure attachment measurement helpers shared by the team store slice.
 * No store state or side effects.
 */

export function estimateBase64Bytes(base64: string | null | undefined): number | null {
  if (typeof base64 !== 'string' || !base64) return null;
  const normalized = base64.includes(',') ? (base64.split(',').pop() ?? '') : base64;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export function getAttachmentTotalSizeBytes(
  attachments:
    | readonly { size?: number; data?: string; base64Data?: string; base64?: string }[]
    | undefined
): number | null {
  if (!attachments?.length) return null;
  let total = 0;
  let hasKnownSize = false;
  for (const attachment of attachments) {
    const size =
      typeof attachment.size === 'number'
        ? attachment.size
        : estimateBase64Bytes(attachment.data ?? attachment.base64Data ?? attachment.base64);
    if (typeof size === 'number' && Number.isFinite(size) && size >= 0) {
      total += size;
      hasKnownSize = true;
    }
  }
  return hasKnownSize ? total : null;
}

export function getAttachmentMimeTypes(
  attachments: readonly { mimeType?: string; type?: string }[] | undefined
): (string | null)[] {
  return attachments?.map((attachment) => attachment.mimeType ?? attachment.type ?? null) ?? [];
}
