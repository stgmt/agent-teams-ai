import { ListCustomTeamTemplatesUseCase } from '@features/custom-team-templates/core/application/ListCustomTeamTemplatesUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateV1 } from '@features/custom-team-templates/contracts';
import type { CustomTeamTemplateStorageGateway } from '@features/custom-team-templates/core/application/ports';

const template: CustomTeamTemplateV1 = {
  templateId: 'tmpl-1',
  name: 'Release Pipeline',
  schemaVersion: 1,
  teamPrompt: 'Deliver the feature.',
  members: [{ name: 'alice' }],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function gatewayWith(list: () => Promise<unknown>): CustomTeamTemplateStorageGateway {
  return {
    customTeamTemplateCreate: vi.fn(),
    customTeamTemplateList: list as CustomTeamTemplateStorageGateway['customTeamTemplateList'],
    customTeamTemplateGetById: vi.fn(),
    customTeamTemplateUpdate: vi.fn(),
    customTeamTemplateDelete: vi.fn(),
  };
}

describe('ListCustomTeamTemplatesUseCase', () => {
  it('distinguishes a valid empty library from unreadable records and valid records', async () => {
    const cases: {
      listed: {
        templates: readonly CustomTeamTemplateV1[];
        unreadableRecords: readonly { templateId: string; reason: 'unreadableRecord' }[];
      };
      expected: unknown;
    }[] = [
      {
        listed: { templates: [], unreadableRecords: [] },
        expected: { status: 'empty' },
      },
      {
        listed: { templates: [template], unreadableRecords: [] },
        expected: { status: 'ready', templates: [template] },
      },
      {
        listed: {
          templates: [template],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
        expected: {
          status: 'hasUnreadableRecords',
          templates: [template],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
      },
      {
        // A wholly unreadable library is still not an empty library.
        listed: {
          templates: [],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
        expected: {
          status: 'hasUnreadableRecords',
          templates: [],
          unreadableRecords: [{ templateId: 'tmpl-broken', reason: 'unreadableRecord' }],
        },
      },
    ];

    for (const testCase of cases) {
      const useCase = new ListCustomTeamTemplatesUseCase({
        gateway: gatewayWith(() => Promise.resolve(testCase.listed)),
      });
      await expect(useCase.execute()).resolves.toEqual(testCase.expected);
    }
  });

  it('never reports a storage failure as an empty library', async () => {
    const failing = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(() => Promise.reject(new Error('worker unavailable'))),
    });
    await expect(failing.execute()).resolves.toEqual({ status: 'storageUnavailable' });

    const absent = new ListCustomTeamTemplatesUseCase({ gateway: null });
    await expect(absent.execute()).resolves.toEqual({ status: 'storageUnavailable' });
  });

  it('does not query the gateway when storage diagnosis is unavailable or inconclusive', async () => {
    const list = vi.fn().mockResolvedValue({ templates: [], unreadableRecords: [] });
    const diagnostic = {
      status: 'storageVerificationRequired' as const,
      storageDirectory: '/server/storage',
      databasePath: '/server/storage/app.db',
    };
    const blocked = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(list),
      diagnoseStorage: () => Promise.resolve(diagnostic),
    });
    await expect(blocked.execute()).resolves.toEqual(diagnostic);
    expect(list).not.toHaveBeenCalled();

    const inconclusive = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(list),
      diagnoseStorage: () => Promise.reject(new Error('cannot diagnose storage')),
    });
    await expect(inconclusive.execute()).resolves.toEqual({ status: 'storageUnavailable' });
    expect(list).not.toHaveBeenCalled();

    const healthy = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(list),
      diagnoseStorage: () => Promise.resolve(null),
    });
    await expect(healthy.execute()).resolves.toEqual({ status: 'empty' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('diagnoses a failed library read without repeating it', async () => {
    const list = vi.fn().mockRejectedValue(new Error('worker stopped'));
    const diagnostic = {
      status: 'storageVerificationRequired' as const,
      storageDirectory: '/server/storage',
      databasePath: '/server/storage/app.db',
    };
    const diagnoseStorage = vi.fn((readFailed?: boolean) =>
      Promise.resolve(readFailed ? diagnostic : null)
    );
    const useCase = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(list),
      diagnoseStorage,
    });

    await expect(useCase.execute()).resolves.toEqual(diagnostic);
    expect(list).toHaveBeenCalledTimes(1);
    expect(diagnoseStorage).toHaveBeenNthCalledWith(1);
    expect(diagnoseStorage).toHaveBeenNthCalledWith(2, true);
  });

  it('reports database damage as requiring recovery rather than an empty library', async () => {
    const useCase = new ListCustomTeamTemplatesUseCase({
      gateway: gatewayWith(() =>
        Promise.resolve({
          templates: [],
          unreadableRecords: [],
          recoveryRequired: {
            kind: 'damaged',
            storageDirectory: '/server/storage',
            markerPath: '/server/storage/app.db.templates-recovery-required',
            interruptedMarkerPath: '/server/storage/app.db.recovery-in-progress',
          },
        })
      ),
    });
    await expect(useCase.execute()).resolves.toEqual({
      status: 'recoveryRequired',
      storageDirectory: '/server/storage',
      markerPath: '/server/storage/app.db.templates-recovery-required',
      interruptedMarkerPath: '/server/storage/app.db.recovery-in-progress',
    });
  });

  it('reads the library without mutating it', async () => {
    const create = vi.fn();
    const getById = vi.fn();
    const useCase = new ListCustomTeamTemplatesUseCase({
      gateway: {
        customTeamTemplateCreate: create,
        customTeamTemplateList: vi
          .fn()
          .mockResolvedValue({ templates: [template], unreadableRecords: [] }),
        customTeamTemplateGetById: getById,
        customTeamTemplateUpdate: vi.fn(),
        customTeamTemplateDelete: vi.fn(),
      },
    });

    await useCase.execute();
    expect(create).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });
});
