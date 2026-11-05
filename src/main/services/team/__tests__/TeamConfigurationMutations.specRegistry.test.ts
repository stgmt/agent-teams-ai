import { describe, expect, it, vi } from 'vitest';

import { updateTeamConfiguration } from '../TeamConfigurationMutations';
import type { TeamMetaFile } from '../TeamMetaStore';

describe('draft specification connection', () => {
  it('updates the saved binding without inventing a launched team config', async () => {
    let meta: TeamMetaFile = { version: 1, cwd: '/sandbox', createdAt: 1 };
    const updateConfig = vi.fn();
    const invalidate = vi.fn();
    const stores = {
      configReader: { getConfig: vi.fn(async () => null), updateConfig },
      teamMetaStore: {
        getMeta: vi.fn(async () => meta),
        serializeMeta: (value: Omit<TeamMetaFile, 'version'>) => JSON.stringify(value),
        updateMeta: async (_team: string, change: (value: TeamMetaFile) => TeamMetaFile) => {
          meta = change(meta);
        },
      },
      invalidate,
    };

    await updateTeamConfiguration(
      'sandbox',
      {
        specProject: 'sandbox/demo',
        specSlug: 'sandbox-spec',
      },
      stores as never
    );

    expect(meta).toMatchObject({ specProject: 'sandbox/demo', specSlug: 'sandbox-spec' });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('sandbox');

    await expect(
      updateTeamConfiguration(
        'sandbox',
        {
          specProject: 'sandbox/demo',
          specSlug: 'different-spec',
        },
        stores as never
      )
    ).rejects.toThrow('SPEC_BINDING_IMMUTABLE');
    expect(meta.specSlug).toBe('sandbox-spec');
  });
});
