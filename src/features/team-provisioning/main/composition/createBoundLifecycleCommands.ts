import { AppContextMismatchError } from '@features/external-agent-connection/main';
import { validateMemberName } from '@main/services/team/TeamIdentifierValidation';

import { parseBoundLifecycleRequest } from '../infrastructure/parseBoundLifecycleRequest';

import type {
  ConfiguredMemberIdentity,
  MemberGenerationTarget,
  TeamRunIdentity,
} from '../../contracts';
import type { MemberLifecycleCommands } from '../../core/application/commands/MemberLifecycleCommands';
import type { TeamLifecycleCommands } from '../../core/application/commands/TeamLifecycleCommands';
import type { LifecycleCommands } from '../../core/application/ports/LifecycleCommands';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

interface Dependencies {
  owner: Readonly<AppConnectionContext>;
  source: Pick<TeamLifecycleCommands, 'launchCurrent' | 'stop'> &
    Pick<MemberLifecycleCommands, 'restart' | 'skip'>;
  load(
    run: Readonly<TeamRunIdentity>,
    signal: AbortSignal
  ): Promise<readonly ConfiguredMemberIdentity[]>;
  invalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
}

function exactRunId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 128)
    throw new TypeError('An exact runId is required');
  return value;
}

/** The lifecycle owner selects the run; external commands cannot invent a replacement identity. */
export function createBoundLifecycleCommands(deps: Dependencies): LifecycleCommands {
  const owner = Object.freeze({ ...deps.owner });
  const memberTarget = (input: unknown): Readonly<MemberGenerationTarget> => {
    const { teamName, fields } = parseBoundLifecycleRequest(input, owner, [
      'runId',
      'memberName',
      'generation',
    ]);
    const member = validateMemberName(fields.memberName);
    if (!member.valid || !member.value || member.value !== fields.memberName)
      throw new TypeError('An exact configured memberName is required');
    if (
      typeof fields.generation !== 'number' ||
      !Number.isSafeInteger(fields.generation) ||
      fields.generation < 0
    )
      throw new TypeError('An observed member generation is required');
    return Object.freeze({
      ...owner,
      teamName,
      runId: exactRunId(fields.runId),
      memberName: member.value,
      generation: fields.generation,
    });
  };
  return {
    launch: async (input) => {
      const { teamName } = parseBoundLifecycleRequest(input, owner);
      return deps.withExpectedContext(owner, async () => {
        const invalidation = deps.invalidationSignal(owner);
        const receipt = await deps.source.launchCurrent(
          owner,
          teamName,
          (run, signal) => deps.load(run, signal),
          invalidation
        );
        if (invalidation.aborted) throw new AppContextMismatchError();
        return Object.freeze({ run: Object.freeze({ ...receipt.run }) });
      });
    },
    stop: async (input) => {
      const { teamName, fields } = parseBoundLifecycleRequest(input, owner, ['runId']);
      const run = Object.freeze({ ...owner, teamName, runId: exactRunId(fields.runId) });
      return deps.withExpectedContext(owner, () => deps.source.stop(run));
    },
    restartMember: async (input) => {
      const target = memberTarget(input);
      return deps.withExpectedContext(owner, async () => {
        const invalidation = deps.invalidationSignal(owner);
        try {
          const receipt = await deps.source.restart(target, invalidation);
          if (invalidation.aborted) throw new AppContextMismatchError();
          return receipt;
        } catch (error) {
          if (invalidation.aborted) throw new AppContextMismatchError();
          throw error;
        }
      });
    },
    skipMember: async (input) => {
      const target = memberTarget(input);
      return deps.withExpectedContext(owner, async () => {
        const invalidation = deps.invalidationSignal(owner);
        try {
          await deps.source.skip(target, invalidation);
          if (invalidation.aborted) throw new AppContextMismatchError();
        } catch (error) {
          if (invalidation.aborted) throw new AppContextMismatchError();
          throw error;
        }
      });
    },
  };
}
