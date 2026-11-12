// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { NativeToolApprovalSettings } from '../../../../src/features/team-provisioning/main/adapters/output/NativeToolApprovalSettings';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/toolApproval';

describe('native tool approval settings', () => {
  it('defaults, initializes per launch and clears on release', () => {
    const store = new NativeToolApprovalSettings();
    expect(store.get('test-team')).toEqual(DEFAULT_TOOL_APPROVAL_SETTINGS);
    store.initializeForLaunch('test-team', true);
    expect(store.get('test-team').autoAllowAll).toBe(true);
    store.initializeForLaunch('test-team', false);
    expect(store.get('test-team').autoAllowAll).toBe(false);
    store.update('test-team', { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true });
    expect(store.get('test-team').autoAllowAll).toBe(true);
    store.clear('test-team');
    expect(store.get('test-team')).toEqual(DEFAULT_TOOL_APPROVAL_SETTINGS);
  });
});
