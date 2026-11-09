import { describe, expect, it } from 'vitest';

import { resolveTeamSpecBinding } from '../TeamSpecBinding';

describe('registry team binding', () => {
  it.each(['owner', 'owner/project/extra', 'owner-/project', 'owner/project.', 'owner/..'])(
    'rejects a project the registry cannot address: %s',
    (project) => {
      expect(() =>
        resolveTeamSpecBinding({ specProject: project, specSlug: 'valid-spec' }, 'team')
      ).toThrow(expect.objectContaining({ code: 'SPEC_PROJECT_INVALID' }));
    }
  );

  it.each(['Uppercase', 'under_score', 'trailing-', 'a'.repeat(121)])(
    'rejects an invalid specification slug: %s',
    (spec) => {
      expect(() =>
        resolveTeamSpecBinding({ specProject: 'owner/project', specSlug: spec }, 'team')
      ).toThrow(expect.objectContaining({ code: 'SPEC_SLUG_INVALID' }));
    }
  );

  it('accepts registry-valid project segments and a lowercase specification slug', () => {
    expect(
      resolveTeamSpecBinding(
        { specProject: 'owner..name/project-2', specSlug: 'feature-2' },
        'team'
      )
    ).toEqual({ project: 'owner..name/project-2', spec: 'feature-2' });
  });
});
