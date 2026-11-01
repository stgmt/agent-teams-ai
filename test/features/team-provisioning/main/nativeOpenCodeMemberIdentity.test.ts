// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNativeOpenCodeMemberIdentity } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberIdentity';

import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';

function config(providerId: string | undefined): TeamConfig {
  return {
    name: 'Alpha',
    projectPath: '/TEST/alpha',
    members: [
      { name: 'team-lead', agentType: 'team-lead', providerId } as never,
      { name: 'builder', agentType: 'general-purpose', providerId } as never,
    ],
  } as never;
}

describe('native OpenCode member identity', () => {
  it('resolves a member to a lane when the team was configured with OpenCode', async () => {
    const identity = await createNativeOpenCodeMemberIdentity({
      readConfig: async () => config('opencode'),
    }).resolveOpenCodeMemberDeliveryIdentity(teamName, 'builder');

    expect(identity.ok).toBe(true);
    if (!identity.ok) throw new Error('expected a resolvable identity');
    expect(identity.canonicalMemberName).toBe('builder');
    expect(identity.laneId).toBe('primary');
  });

  it('refuses a member of a team that is not OpenCode', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      readConfig: async () => config('claude'),
    });

    await expect(
      subject.resolveOpenCodeMemberDeliveryIdentity(teamName, 'builder')
    ).resolves.toMatchObject({ ok: false, reason: 'recipient_is_not_opencode' });
    await expect(subject.isOpenCodeRuntimeRecipient(teamName, 'builder')).resolves.toBe(false);
  });

  it('uses persisted launch metadata to place a member without its own provider entry', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      // A team launched as OpenCode records the provider once, not per member.
      readConfig: async () => ({
        name: 'Alpha',
        projectPath: '/TEST/alpha',
        members: [
          { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' },
          {
            name: 'builder',
            agentType: 'general-purpose',
            provider: 'opencode',
          } as never,
        ],
      } as never),
      readTeamMeta: async () => ({ launchIdentity: { providerId: 'opencode' } }),
    });

    await expect(subject.isOpenCodeRuntimeRecipient(teamName, 'builder')).resolves.toBe(true);
  });

  it('reports an unknown member as unavailable rather than guessing a lane', async () => {
    const subject = createNativeOpenCodeMemberIdentity({
      readConfig: async () => config('opencode'),
    });

    await expect(
      subject.resolveOpenCodeMemberDeliveryIdentity(teamName, 'nobody')
    ).resolves.toMatchObject({ ok: false, reason: 'opencode_recipient_unavailable' });
  });
});
