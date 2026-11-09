// @vitest-environment node
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { setAppDataBasePath } from '@main/utils/pathDecoder';
import { describe, expect, it } from 'vitest';

import { TeamTaskAttachmentStore } from '../TeamTaskAttachmentStore';

describe('TeamTaskAttachmentStore.saveAttachmentBuffer', () => {
  it('writes validated bytes under the app-owned task attachment root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-attachment-buffer-'));
    setAppDataBasePath(root);
    try {
      const store = new TeamTaskAttachmentStore();
      const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
      const meta = await store.saveAttachmentBuffer(
        'alpha-team',
        'registry-task-1',
        '123e4567-e89b-42d3-a456-426614174000',
        'proof.bin',
        'application/octet-stream',
        bytes
      );

      expect(meta).toMatchObject({
        id: '123e4567-e89b-42d3-a456-426614174000',
        filename: 'proof.bin',
        size: bytes.length,
      });
      expect(meta.filePath).toBe(
        path.join(
          root,
          'data',
          'task-attachments',
          'alpha-team',
          'registry-task-1',
          '123e4567-e89b-42d3-a456-426614174000--proof.bin'
        )
      );
      expect(await fs.readFile(meta.filePath!)).toEqual(bytes);
    } finally {
      setAppDataBasePath(null);
      await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});
