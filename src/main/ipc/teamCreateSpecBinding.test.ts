import { describe, expect, it } from 'vitest';

import { resolveCreateTeamSpecBinding } from './teamCreateSpecBinding';

describe('resolveCreateTeamSpecBinding', () => {
  it('keeps the binding the operator picked', () => {
    expect(
      resolveCreateTeamSpecBinding({ specProject: 'stgmt/tokenplan', specSlug: ' registry-check ' })
    ).toEqual({
      ok: true,
      value: {
        specScope: {
          projects: ['stgmt/tokenplan'],
          bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }],
        },
      },
    });
  });

  it('accepts a project without a spec', () => {
    expect(resolveCreateTeamSpecBinding({ specProject: 'stgmt/tokenplan' })).toEqual({
      ok: true,
      value: { specScope: { projects: ['stgmt/tokenplan'], bindings: [] } },
    });
  });

  it('accepts a request without any binding', () => {
    expect(resolveCreateTeamSpecBinding({})).toEqual({ ok: true, value: {} });
  });

  it('refuses a slug without a project', () => {
    expect(resolveCreateTeamSpecBinding({ specSlug: 'registry-check' })).toEqual({
      ok: false,
      error: 'specSlug requires specProject',
    });
  });

  it('refuses an empty binding field instead of dropping it', () => {
    expect(resolveCreateTeamSpecBinding({ specProject: '   ' })).toEqual({
      ok: false,
      error: 'specProject must be a non-empty string',
    });
    expect(resolveCreateTeamSpecBinding({ specProject: 'p', specSlug: 7 })).toEqual({
      ok: false,
      error: 'specSlug must be a non-empty string',
    });
  });
});
