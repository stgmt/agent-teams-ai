import { describe, expect, it } from 'vitest';

import { isTeamSpecBindingSelectionValid, registrySelectionKey } from './teamSpecBindingSelection';

describe('team specification binding selection', () => {
  it('allows creating a team with no registry binding', () => {
    expect(isTeamSpecBindingSelectionValid('', '', null)).toBe(true);
    expect(isTeamSpecBindingSelectionValid('  ', '  ', null)).toBe(true);
  });

  it('rejects partial bindings and unverified or stale selections', () => {
    expect(isTeamSpecBindingSelectionValid('product', '', null)).toBe(false);
    expect(isTeamSpecBindingSelectionValid('', 'editor', null)).toBe(false);
    expect(isTeamSpecBindingSelectionValid('product', 'editor', null)).toBe(false);
    expect(
      isTeamSpecBindingSelectionValid('product', 'editor', registrySelectionKey('product', 'api'))
    ).toBe(false);
  });

  it('accepts only the verified complete project and specification pair', () => {
    expect(
      isTeamSpecBindingSelectionValid(
        ' product ',
        ' editor ',
        registrySelectionKey('product', 'editor')
      )
    ).toBe(true);
  });
});
