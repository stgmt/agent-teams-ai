import { createHash } from 'node:crypto';

import type { MemberProcessToken } from '../../contracts';

export function personalTaskListId(
  token: Pick<MemberProcessToken, 'dataRootFingerprint' | 'teamName' | 'memberName'>
): string {
  const identity = JSON.stringify([token.dataRootFingerprint, token.teamName, token.memberName]);
  return `agts-personal-v1-${createHash('sha256').update(identity).digest('hex')}`;
}
