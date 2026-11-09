// Cross-process registration reservation worker, launched through tsx.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TeamMetaStore } from '../../../../../src/main/services/team/TeamMetaStore';

async function main(): Promise<void> {
  const [basePath, workerId, project, securityStoreId = 'store-1'] = process.argv.slice(2);
  if (!basePath || !workerId || !project || !/^[a-z0-9-]+$/.test(workerId)) {
    throw new Error('Invalid worker arguments');
  }
  await fs.writeFile(path.join(basePath, `ready-${workerId}`), 'ready', { flag: 'wx' });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      await fs.access(path.join(basePath, 'go'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) throw new Error('Start barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const store = new TeamMetaStore();
  const result = await store.prepareRegistryRegistration('team', project, basePath);
  await store.fenceRegistryRegistration('team', project, result.requestId,
    { securityStoreId, idp: 'idp-1', userId: 'user-1' }, basePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
