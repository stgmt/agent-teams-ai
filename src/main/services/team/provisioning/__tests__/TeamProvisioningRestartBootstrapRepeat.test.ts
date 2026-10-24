import * as agentTeamsControllerModule from 'agent-teams-controller';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamProvisioningMemberLifecycleController } from '../TeamProvisioningMemberLifecycle';
import { persistTeamProvisioningInboxMessage } from '../TeamProvisioningMessagePersistence';

import type { TeamProvisioningMemberLifecycleHost } from '../TeamProvisioningMemberLifecycleHostPorts';
import type { InboxMessage } from '@shared/types';

// A restart sends the same bootstrap check to the same teammate again. The controller drops an
// identical repeated message (same sender, recipient, text and lead session within 30 minutes),
// so without an explicit opt-out the second restart never gets its row and the new process never
// bootstraps. This is the path the "Save and restart" button takes, with the real controller.

const { createController } = agentTeamsControllerModule;

const TEAM = 'my-team';
const BOOTSTRAP_CHECK =
  '<agent_teams_native_app_managed_bootstrap_check>\n</agent_teams_native_app_managed_bootstrap_check>';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

function makeClaudeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-bootstrap-repeat-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'teams', TEAM), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'teams', TEAM, 'config.json'),
    JSON.stringify({
      name: TEAM,
      leadSessionId: 'lead-session-1',
      members: [
        { name: 'alice', role: 'team-lead' },
        { name: 'bob', role: 'developer' },
      ],
    })
  );
  return dir;
}

function readInbox(claudeDir: string): { messageId: string; read: boolean; text: string }[] {
  return JSON.parse(
    fs.readFileSync(path.join(claudeDir, 'teams', TEAM, 'inboxes', 'bob.json'), 'utf8')
  ) as { messageId: string; read: boolean; text: string }[];
}

function markAllRead(claudeDir: string): void {
  const file = path.join(claudeDir, 'teams', TEAM, 'inboxes', 'bob.json');
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as { read: boolean }[];
  fs.writeFileSync(file, JSON.stringify(rows.map((row) => ({ ...row, read: true }))));
}

function lifecycleWithRealInbox(claudeDir: string): TeamProvisioningMemberLifecycleController {
  // РИСК: the host is cut down to the one port this method uses; the rest of the restart chain
  // is covered by the use case tests and the live test. The inbox side is the real controller.
  const host = {
    persistInboxMessage: (teamName: string, recipient: string, message: Record<string, unknown>) =>
      persistTeamProvisioningInboxMessage(teamName, recipient, message as unknown as InboxMessage, {
        createController: (input) => createController(input),
        getClaudeBasePath: () => claudeDir,
        logger: { warn: vi.fn() },
        emitRuntimeDeliveryReplyAdvisoryRefresh: vi.fn(),
      }),
  } as unknown as TeamProvisioningMemberLifecycleHost;
  return new TeamProvisioningMemberLifecycleController(host, {
    isMemberLifecycleOperationActive: () => false,
    async runMemberLifecycleOperation(_teamName, _memberName, _kind, operation) {
      return operation();
    },
  });
}

function enqueueBootstrapCheck(
  lifecycle: TeamProvisioningMemberLifecycleController,
  operation: 'manual_restart' | 'member_updated'
): void {
  (
    lifecycle as unknown as {
      enqueueDirectRestartPromptInternal(input: Record<string, unknown>): void;
    }
  ).enqueueDirectRestartPromptInternal({
    teamName: TEAM,
    memberName: 'bob',
    leadName: 'alice',
    leadSessionId: 'lead-session-1',
    prompt: BOOTSTRAP_CHECK,
    operation,
  });
}

describe('restart bootstrap check delivery (real controller)', () => {
  it('delivers the bootstrap check to every restart attempt of the same teammate', () => {
    const claudeDir = makeClaudeDir();
    const lifecycle = lifecycleWithRealInbox(claudeDir);

    enqueueBootstrapCheck(lifecycle, 'manual_restart');
    markAllRead(claudeDir);
    enqueueBootstrapCheck(lifecycle, 'manual_restart');
    markAllRead(claudeDir);
    enqueueBootstrapCheck(lifecycle, 'manual_restart');

    const rows = readInbox(claudeDir);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.messageId)).size).toBe(3);
    expect(rows.every((row) => row.text === BOOTSTRAP_CHECK)).toBe(true);
    expect(rows.map((row) => row.read)).toEqual([true, true, false]);
  });

  it('delivers the bootstrap check of a saved member after a restart row for the same text', () => {
    const claudeDir = makeClaudeDir();
    const lifecycle = lifecycleWithRealInbox(claudeDir);

    enqueueBootstrapCheck(lifecycle, 'manual_restart');
    enqueueBootstrapCheck(lifecycle, 'member_updated');

    expect(readInbox(claudeDir)).toHaveLength(2);
  });
});
