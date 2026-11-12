import { describe, expect, it } from 'vitest';

import {
  bindingFromTeamMetadata,
  resolveTeamSpecBinding,
  resolveTeamSpecScope,
} from '../TeamSpecBinding';

describe('registry team binding', () => {
  it.each(['owner', 'owner/project/extra', 'owner-/project', 'owner/project.', 'owner/..'])(
    'rejects a project the registry cannot address: %s',
    (project) => {
      expect(() =>
        resolveTeamSpecBinding(
          {
            specScope: {
              projects: [project],
              bindings: [{ project, spec: 'valid-spec' }],
            },
          },
          'team'
        )
      ).toThrow(expect.objectContaining({ code: 'SPEC_PROJECT_INVALID' }));
    }
  );

  it.each(['Uppercase', 'under_score', 'trailing-', 'a'.repeat(121)])(
    'rejects an invalid specification slug: %s',
    (spec) => {
      expect(() =>
        resolveTeamSpecBinding(
          {
            specScope: {
              projects: ['owner/project'],
              bindings: [{ project: 'owner/project', spec }],
            },
          },
          'team'
        )
      ).toThrow(expect.objectContaining({ code: 'SPEC_SLUG_INVALID' }));
    }
  );

  it('accepts registry-valid project segments and a lowercase specification slug', () => {
    expect(
      resolveTeamSpecBinding(
        {
          specScope: {
            projects: ['owner..name/project-2'],
            bindings: [{ project: 'owner..name/project-2', spec: 'feature-2' }],
          },
        },
        'team'
      )
    ).toEqual({ project: 'owner..name/project-2', spec: 'feature-2' });
  });

  it('accepts project authority before any specification exists', () => {
    expect(
      resolveTeamSpecScope({
        specScope: { projects: ['owner/project'], bindings: [] },
      })
    ).toEqual({ projects: ['owner/project'], bindings: [] });
  });

  it('refuses a runtime projection that widens metadata-owned project access', () => {
    const meta = { specScope: { projects: ['owner/project'], bindings: [] } };
    expect(() =>
      bindingFromTeamMetadata(
        {
          specScope: { projects: ['owner/project', 'other/project'], bindings: [] },
        },
        meta
      )
    ).toThrow(expect.objectContaining({ code: 'SPEC_BINDINGS_INVALID' }));
  });
});
