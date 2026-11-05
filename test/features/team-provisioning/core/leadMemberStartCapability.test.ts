import { describe, expect, it } from 'vitest';

import { LeadMemberStartAuthority } from '../../../../src/features/team-provisioning/core/application/LeadMemberStartAuthority';
import { StartBoundMember } from '../../../../src/features/team-provisioning/core/application/commands/StartBoundMember';

const run = {
  appInstanceId: 'app',
  dataRootFingerprint: 'root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'run',
};

function setup() {
  const authority = new LeadMemberStartAuthority();
  authority.bind('opaque-launch-credential', run);
  const calls: unknown[] = [];
  const command = new StartBoundMember(authority, {
    async start(identity, memberName) {
      calls.push({ identity, memberName });
      return { kind: 'already-running' };
    },
  });
  return { authority, calls, command };
}

describe('lead capability for starting configured members', () => {
  it('derives the own team and run from a server-issued credential', async () => {
    const { command, calls } = setup();
    expect(await command.execute('opaque-launch-credential', { memberName: 'builder' })).toEqual({
      kind: 'already-running',
    });
    expect(calls).toEqual([{ identity: run, memberName: 'builder' }]);
  });

  it('rejects actor assertions instead of treating a supplied name as authorization', async () => {
    const { command, calls } = setup();
    await expect(command.execute('team-lead', { memberName: 'builder' })).rejects.toThrow(
      'Unauthorized'
    );
    expect(calls).toEqual([]);
  });

  it.each(['teamName', 'runId', 'model', 'command', 'role', 'cwd', 'actor'])(
    'rejects the untrusted %s field',
    async (field) => {
      const { command, calls } = setup();
      await expect(
        command.execute('opaque-launch-credential', { memberName: 'builder', [field]: 'injected' })
      ).rejects.toThrow('memberName');
      expect(calls).toEqual([]);
    }
  );

  it('revokes the old lead capability when its run stops or is replaced', async () => {
    const { command, authority, calls } = setup();
    authority.revokeRun(run);
    await expect(
      command.execute('opaque-launch-credential', { memberName: 'builder' })
    ).rejects.toThrow('Unauthorized');
    expect(calls).toEqual([]);
  });

  it('provides a credential to the exact owned launch only and refuses foreign or revoked runs', () => {
    const { authority } = setup();
    expect(authority.credentialFor(run)).toBe('opaque-launch-credential');
    expect(() => authority.credentialFor({ ...run, connectionGeneration: 2 })).toThrow(
      'Unauthorized'
    );
    authority.revokeRun(run);
    expect(() => authority.credentialFor(run)).toThrow('Unauthorized');
  });

  it('refuses a second credential for the same run instead of retaining ambiguous lead authority', () => {
    const { authority } = setup();
    expect(() => authority.bind('TEST-second-credential', { ...run })).toThrow('already has');
    expect(authority.credentialFor(run)).toBe('opaque-launch-credential');
    expect(() => authority.resolve('TEST-second-credential')).toThrow('Unauthorized');
    authority.revokeRun(run);
    authority.bind('TEST-second-credential', run);
    expect(authority.credentialFor(run)).toBe('TEST-second-credential');
  });

  it('does not allow credential rebinding to another team', () => {
    const { authority } = setup();
    expect(() => authority.bind('opaque-launch-credential', { ...run, teamName: 'other' })).toThrow(
      'already bound'
    );
  });
});
