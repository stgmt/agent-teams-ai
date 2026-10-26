import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const { createController } = require('../src/index.js');
let root: string | undefined;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function createTeamController() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-controller-reply-link-'));
  fs.mkdirSync(path.join(root, 'teams', 'TEST-team'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'teams', 'TEST-team', 'config.json'),
    JSON.stringify({ name: 'TEST-team', members: [{ name: 'lead', role: 'team-lead' }] })
  );
  return createController({ claudeDir: root, teamName: 'TEST-team' });
}

describe('controller user reply link persistence', () => {
  it('persists reply-link fields on sent messages', () => {
    const controller = createTeamController();
    controller.messages.appendSentMessage({
      messageId: 'reply',
      from: 'lead',
      to: 'user',
      text: 'Report is ready',
      source: 'lead_process',
      replyToMessageIds: ['req-1', ' req-2 ', 'req-1'],
      replyChannel: 'fallback',
      focusOnly: true,
    });
    const { message: row } = controller.messages.lookupMessage('reply');
    expect(row.replyToMessageIds).toEqual(['req-1', 'req-2']);
    expect(row.replyChannel).toBe('fallback');
    expect(row.focusOnly).toBe(true);
  });

  it('drops unknown reply channels and non-true focus flags', () => {
    const controller = createTeamController();
    controller.messages.appendSentMessage({
      messageId: 'reply',
      from: 'lead',
      to: 'user',
      text: 'Hi',
      replyChannel: 'plain_text',
      focusOnly: 'yes',
    });
    const { message: row } = controller.messages.lookupMessage('reply');
    expect(row).not.toHaveProperty('replyChannel');
    expect(row).not.toHaveProperty('focusOnly');
    expect(row).not.toHaveProperty('replyToMessageIds');
  });
});
