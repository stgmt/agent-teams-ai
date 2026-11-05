import { CopyBuiltinTemplateUseCase } from '@features/custom-team-templates/core/application/CopyBuiltinTemplateUseCase';
import { CustomTeamTemplateStorageInterruptedError } from '@features/custom-team-templates/core/application/CustomTeamTemplateStorageInterruptedError';
import { DeleteCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/DeleteCustomTeamTemplateUseCase';
import { DuplicateCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/DuplicateCustomTeamTemplateUseCase';
import { ImportCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/ImportCustomTeamTemplateUseCase';
import { UpdateCustomTeamTemplateUseCase } from '@features/custom-team-templates/core/application/UpdateCustomTeamTemplateUseCase';
import { STORAGE_SETTLEMENT_TIMEOUT_MS } from '@features/custom-team-templates/core/application/waitForStorageSettlement';
import { NodeCustomTeamTemplateHasher } from '@features/custom-team-templates/main/adapters/output/NodeCustomTeamTemplateHasher';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const source = {
  templateId: 'source',
  name: 'Source',
  schemaVersion: 1 as const,
  teamPrompt: 'Build',
  members: [{ name: 'alice', role: 'reviewer', workflow: 'Review' }],
  revision: 1,
};
const hasher = new NodeCustomTeamTemplateHasher();

describe('writes whose interrupted worker has not confirmed termination', () => {
  it.each(['import', 'copy', 'duplicate', 'update', 'delete'] as const)(
    '%s does not retry or claim an outcome from a premature read',
    async (operation) => {
      vi.useFakeTimers();
      try {
        const error = new CustomTeamTemplateStorageInterruptedError(
          'worker termination unconfirmed',
          'unknown',
          new Promise<void>(() => {})
        );
        const write = vi.fn().mockRejectedValue(error);
        const read = vi.fn().mockResolvedValue({ status: 'found', template: source });
        const gateway: CustomTeamTemplateStorageGateway = {
          customTeamTemplateCreate: write,
          customTeamTemplateUpdate: write,
          customTeamTemplateDelete: write,
          customTeamTemplateGetById: read,
          customTeamTemplateList: vi.fn(),
        };
        const deps = { gateway, hasher, createTemplateId: () => 'new-id' };
        let pending: Promise<unknown>;
        switch (operation) {
          case 'import':
            pending = new ImportCustomTeamTemplateUseCase(deps).execute({
              portable: {
                format: 'agent-teams-custom-template',
                schemaVersion: 1,
                name: 'Imported',
                teamPrompt: source.teamPrompt,
                members: source.members,
              },
            });
            break;
          case 'copy':
            pending = new CopyBuiltinTemplateUseCase({
              ...deps,
              resolveBuiltin: () => ({
                schemaVersion: 1,
                teamPrompt: source.teamPrompt,
                members: source.members,
              }),
            }).execute({ builtinTemplateId: 'builtin', name: 'Copy' });
            break;
          case 'duplicate':
            pending = new DuplicateCustomTeamTemplateUseCase(deps).execute({
              sourceTemplateId: 'source',
              name: 'Duplicate',
            });
            break;
          case 'update':
            pending = new UpdateCustomTeamTemplateUseCase(deps).execute({
              templateId: 'source',
              expectedRevision: 1,
              fields: {
                name: source.name,
                teamPrompt: source.teamPrompt,
                members: source.members,
              },
            });
            break;
          case 'delete':
            pending = new DeleteCustomTeamTemplateUseCase({ gateway }).execute({
              templateId: 'source',
              expectedRevision: 1,
            });
            break;
        }
        await vi.advanceTimersByTimeAsync(STORAGE_SETTLEMENT_TIMEOUT_MS);
        await expect(pending).resolves.toEqual({
          status: 'unresolvedWriteOutcome',
          templateId: operation === 'update' || operation === 'delete' ? 'source' : 'new-id',
        });
        expect(write).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(operation === 'duplicate' ? 1 : 0);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
