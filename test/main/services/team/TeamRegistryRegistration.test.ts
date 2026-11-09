import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { TeamRegistryRegistration } from '@main/services/team/TeamRegistryRegistration';

const identity = { securityStoreId: 'store-1', idp: 'issuer', userId: 'user-1' };

describe('fenced registry registration', () => {
  let base = '';
  afterEach(async () => {
    if (base) await fs.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    base = '';
  });

  it('replays the same durable request and identity after an unknown timeout', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-fence-'));
    await fs.mkdir(path.join(base, 'team'));
    const store = new TeamMetaStore();
    await store.writeMeta('team', { cwd: '', createdAt: 1 }, base);
    const getRegistrationIdentity = vi.fn().mockResolvedValue(identity);
    const registerTeam = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce({ teamId: 'team-id', bindings: [] });
    const coordinator = new TeamRegistryRegistration(store, async () => ({ getRegistrationIdentity, registerTeam }), base);
    await expect(coordinator.register('team', 'owner/project')).rejects.toThrow('timeout');
    const pending = await store.getMeta('team', base, { requireCompleteFields: true });
    expect(pending).toMatchObject({ registryRegistrationProtocol: 1, registryRegistrationIdentity: identity, registryRegistrationProject: 'owner/project' });
    await expect(coordinator.register('team', 'owner/project')).resolves.toEqual({ teamId: 'team-id' });
    expect(registerTeam).toHaveBeenCalledTimes(2);
    expect(registerTeam.mock.calls[0]).toEqual(registerTeam.mock.calls[1]);
    expect(registerTeam.mock.calls[0]).toEqual(['owner/project', pending?.registryRegistrationRequestId, identity]);
    expect(await store.getMeta('team', base)).toMatchObject({ registryTeamId: 'team-id' });
  });

  it('refuses a changed identity before sending register and preserves the first fence', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-fence-'));
    await fs.mkdir(path.join(base, 'team'));
    const store = new TeamMetaStore();
    await store.writeMeta('team', { cwd: '', createdAt: 1 }, base);
    const reservation = await store.prepareRegistryRegistration('team', 'owner/project', base);
    await store.fenceRegistryRegistration('team', 'owner/project', reservation.requestId, identity, base);
    const registerTeam = vi.fn();
    const coordinator = new TeamRegistryRegistration(store, async () => ({
      getRegistrationIdentity: async () => ({ ...identity, securityStoreId: 'different-store' }),
      registerTeam,
    }), base);
    await expect(coordinator.register('team', 'owner/project')).rejects.toThrow('identity mismatch');
    expect(registerTeam).not.toHaveBeenCalled();
    expect(await store.getMeta('team', base)).toMatchObject({ registryRegistrationIdentity: identity });
  });

  it('does not replay an unfenced legacy pending registration', async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-fence-'));
    await fs.mkdir(path.join(base, 'team'));
    const store = new TeamMetaStore();
    await store.writeMeta('team', { cwd: '', createdAt: 1, registryRegistrationRequestId: 'old', registryRegistrationProject: 'owner/project' }, base);
    const clientFactory = vi.fn();
    const coordinator = new TeamRegistryRegistration(store, clientFactory, base);
    await expect(coordinator.register('team', 'owner/project')).rejects.toThrow('outcome is unknown');
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
