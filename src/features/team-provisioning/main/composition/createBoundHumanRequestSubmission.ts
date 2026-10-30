import { AppContextMismatchError } from '@features/external-agent-connection/main';

import { parseBoundLifecycleRequest } from '../infrastructure/parseBoundLifecycleRequest';

import type { LeadRequestDeliveryReceipt, TeamRunIdentity } from '../../contracts';
import type { HumanRequestSubmission } from '../../core/application/ports/HumanRequestSubmission';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

interface Dependencies {
  owner: Readonly<AppConnectionContext>;
  submit(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string,
    text: string
  ): Promise<LeadRequestDeliveryReceipt>;
  invalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
}

function exactIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
}

/** Human submission belongs to the bound application, never a model's scoped lead capability. */
export function createBoundHumanRequestSubmission(deps: Dependencies): HumanRequestSubmission {
  const owner = Object.freeze({ ...deps.owner });
  return {
    submit: async (input) => {
      const { teamName, fields } = parseBoundLifecycleRequest(input, owner, [
        'runId',
        'requestMessageId',
        'text',
      ]);
      const { runId, requestMessageId, text } = fields;
      if (!exactIdentity(runId, 128)) throw new TypeError('An exact runId is required');
      if (!exactIdentity(requestMessageId, 256))
        throw new TypeError('An exact human request identity is required');
      if (typeof text !== 'string' || !text.trim() || text.length > 64_000)
        throw new TypeError('An original human question of at most 64000 characters is required');
      const run = Object.freeze({ ...owner, teamName, runId });
      return deps.withExpectedContext(owner, async () => {
        const invalidation = deps.invalidationSignal(owner);
        if (invalidation.aborted) throw new AppContextMismatchError();
        try {
          const receipt = await deps.submit(run, requestMessageId, text);
          if (invalidation.aborted) throw new AppContextMismatchError();
          return receipt;
        } catch (error) {
          if (invalidation.aborted) throw new AppContextMismatchError();
          throw error;
        }
      });
    },
  };
}
