import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { parseCreateTeamRequest } from '@main/services/team/TeamRequestValidation';
import { applyDistinctRosterColors } from '@main/services/team/teamRosterColors';

import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { TeamCreateConfigRequest, TeamMember } from '@shared/types';
import type { Stats } from 'node:fs';

interface Dependencies {
  teamsRoot: string;
  tasksRoot: string;
  metadata: Pick<TeamMetaStore, 'serializeMeta'>;
  members: Pick<TeamMembersMetaStore, 'serializeMembers'>;
  invalidate(): void;
}

function validated(request: TeamCreateConfigRequest): TeamCreateConfigRequest {
  const parsed = parseCreateTeamRequest({ ...request, runtimeSelectionVersion: 1 });
  // The existing serializer accepts obsolete backend aliases. New definitions do not.
  for (const [raw, normalized] of [
    [request, parsed],
    ...request.members.map((member, index) => [member, parsed.members[index]]),
  ]) {
    if (raw.providerBackendId && raw.providerBackendId !== normalized.providerBackendId) {
      throw new Error('Configured provider backend is not valid for this provider');
    }
  }
  return parsed;
}

/** Creates canonical intent only. Runtime config is materialized by the admitted launch command. */
export class NodeTeamDefinitionStore {
  constructor(private readonly ports: Dependencies) {}

  async create(input: TeamCreateConfigRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const request = validated(input);
    const createdAt = Date.now();
    const members: TeamMember[] = applyDistinctRosterColors(
      request.members.map((member) => ({
        ...member,
        agentType: 'general-purpose',
        joinedAt: createdAt,
      }))
    );
    const metaText = this.ports.metadata.serializeMeta({
      ...request,
      cwd: request.cwd ?? '',
      createdAt,
    });
    const membersText = this.ports.members.serializeMembers(members, request);
    const teamDirectory = join(this.ports.teamsRoot, request.teamName);
    const tasksDirectory = join(this.ports.tasksRoot, request.teamName);
    const owned: { path: string; identity: Stats; directory: boolean }[] = [];
    const createDirectory = async (path: string): Promise<void> => {
      signal.throwIfAborted();
      await fs.mkdir(path, { mode: 0o700 });
      owned.push({ path, identity: await fs.lstat(path), directory: true });
    };
    const createFile = async (path: string, text: string): Promise<void> => {
      signal.throwIfAborted();
      const handle = await fs.open(path, 'wx', 0o600);
      try {
        owned.push({ path, identity: await handle.stat(), directory: false });
        await handle.writeFile(text, 'utf8');
      } finally {
        await handle.close();
      }
    };
    for (const root of [this.ports.teamsRoot, this.ports.tasksRoot]) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Team definition root must not be redirected');
    }
    try {
      await createDirectory(teamDirectory);
      await createDirectory(tasksDirectory);
      await createDirectory(join(teamDirectory, 'inboxes'));
      await createFile(join(teamDirectory, 'team.meta.json'), metaText);
      await createFile(join(teamDirectory, 'members.meta.json'), membersText);
      signal.throwIfAborted();
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of owned.toReversed()) {
        try {
          const current = await fs.lstat(entry.path);
          if (current.dev !== entry.identity.dev || current.ino !== entry.identity.ino)
            throw new Error('Team definition path ownership changed');
          // Never recursively remove a public directory: another writer's data must survive.
          for (let attempt = 0; ; attempt++) {
            try {
              if (entry.directory) await fs.rmdir(entry.path);
              else await fs.unlink(entry.path);
              break;
            } catch (cleanupError) {
              if (
                attempt >= 20 ||
                !['EBUSY', 'EPERM', 'EACCES'].includes(
                  (cleanupError as NodeJS.ErrnoException).code ?? ''
                )
              )
                throw cleanupError;
              await delay(250);
            }
          }
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          'Team definition creation failed; owned cleanup is incomplete'
        );
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`Team already exists: ${request.teamName}`);
      throw error;
    }
    this.ports.invalidate();
  }
}
