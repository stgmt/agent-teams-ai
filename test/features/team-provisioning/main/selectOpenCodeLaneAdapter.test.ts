// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { selectOpenCodeLaneAdapter } from '../../../../src/features/team-provisioning/main/composition/selectOpenCodeLaneAdapter';

import type { TeamLaunchRuntimeAdapter } from '../../../../src/main/services/team/runtime';

const adapter = { launch: vi.fn() } as unknown as TeamLaunchRuntimeAdapter;

describe('OpenCode lane adapter selection', () => {
  it('returns nothing without a registry or without the OpenCode entry', () => {
    expect(selectOpenCodeLaneAdapter(undefined)).toBeUndefined();
    const empty = { has: vi.fn(() => false), get: vi.fn() };
    expect(selectOpenCodeLaneAdapter(empty)).toBeUndefined();
    expect(empty.get).not.toHaveBeenCalled();
  });

  it('returns the registered OpenCode adapter', () => {
    const registry = {
      has: vi.fn((providerId: string) => providerId === 'opencode'),
      get: vi.fn((providerId: string) => {
        if (providerId !== 'opencode') throw new Error('unexpected provider');
        return adapter;
      }),
    };
    expect(selectOpenCodeLaneAdapter(registry)).toBe(adapter);
    expect(registry.has).toHaveBeenCalledWith('opencode');
    expect(registry.get).toHaveBeenCalledWith('opencode');
  });
});
