import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import { registryTaskId } from '../RegistryTaskIdentity';
import { executionFields } from '../RegistryTeamTaskProjection';

describe('registry task execution projection', () => {
  it('preserves artifact requirements and attachments through the execution record', () => {
    const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-projection-'));
    try {
      const binding = { project: 'owner/project', spec: 'example' };
      const store = new ExecutionTaskStore({ basePath });
      const attachments = [
        {
          id: 'a',
          filename: 'proof.txt',
          mimeType: 'text/plain',
          size: 1,
          addedAt: '2026-01-01T00:00:00.000Z',
          filePath: '/proof.txt',
        },
      ];
      const artifactRequirement = {
        required: true,
        expectedFilename: 'proof.txt',
        proof: { attachmentId: 'a', sha256: 'a'.repeat(64), size: 1 },
      };
      store.write('team', registryTaskId({ ...binding, localId: '1' }), {
        attachments,
        artifactRequirement,
      });
      expect(executionFields(store, 'team', binding, '1')).toMatchObject({
        attachments,
        artifactRequirement,
      });
    } finally {
      fs.rmSync(basePath, { recursive: true, force: true });
    }
  });
});
