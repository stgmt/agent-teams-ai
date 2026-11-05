import * as fs from 'node:fs';
import * as path from 'node:path';

import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamMembersMetaStore } from './TeamMembersMetaStore';
import type { TeamSummary } from '@shared/types';

/** Summarize a team saved before its runtime created config.json. */
export async function readDraftTeamSummary(
  teamsDir: string,
  teamName: string,
  membersMetaStore: Pick<TeamMembersMetaStore, 'getMembers'>,
  readTimeoutMs: number
): Promise<TeamSummary | null> {
  const metaPath = path.join(teamsDir, teamName, 'team.meta.json');
  try {
    const metaStat = await fs.promises.stat(metaPath);
    if (!metaStat.isFile() || metaStat.size > 256 * 1024) return null;
    const metaRaw = await readFileUtf8WithTimeout(metaPath, readTimeoutMs);
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    if (meta?.version !== 1 || typeof meta?.cwd !== 'string') return null;
    const displayName =
      typeof meta.displayName === 'string' && meta.displayName.trim()
        ? meta.displayName.trim()
        : teamName;

    let memberCount = 0;
    let leadName: string | undefined;
    let leadColor: string | undefined;
    try {
      const members = await membersMetaStore.getMembers(teamName);
      memberCount = members.filter((member) => {
        const name = member.name?.trim() ?? '';
        if (!member.removedAt && isLeadMember(member)) {
          if (name) leadName = name;
          const color = member.color?.trim();
          if (color) leadColor = color;
        }
        if (!name || name === 'user' || isLeadMember(member)) return false;
        return !member.removedAt;
      }).length;
    } catch {
      // Metadata remains useful when the member list is unavailable.
    }

    return {
      teamName,
      displayName,
      description: typeof meta.description === 'string' ? meta.description : '',
      memberCount,
      taskCount: 0,
      lastActivity:
        typeof meta.createdAt === 'number' ? new Date(meta.createdAt).toISOString() : null,
      color: typeof meta.color === 'string' ? meta.color : undefined,
      ...(leadName ? { leadName } : {}),
      ...(leadColor ? { leadColor } : {}),
      projectPath: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      specProject: typeof meta.specProject === 'string' ? meta.specProject : undefined,
      specSlug: typeof meta.specSlug === 'string' ? meta.specSlug : undefined,
      pendingCreate: true,
      deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : undefined,
    };
  } catch {
    return null;
  }
}
