import * as agentTeamsControllerModule from 'agent-teams-controller';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deliverStartupWorkAfterConfirmation } from '../TeamProvisioningStartupWorkDelivery';

const { createController } = agentTeamsControllerModule;

// Real controller, real board and inbox files in a temp Claude root. The only
// recorders are the diagnostic and log sinks, which are outputs, not behavior under test.

interface InboxRow {
  messageId?: string;
  read?: boolean;
  summary?: string;
  text?: string;
}

describe('startup work delivery after a confirmed launch', () => {
  let claudeDir = '';
  const diagnostics: string[] = [];
  const warnings: string[] = [];

  const teamDir = () => join(claudeDir, 'teams', 'fixture');
  const inbox = (member: string): InboxRow[] => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as InboxRow[]) : [];
  };
  const startupRows = (member: string) =>
    inbox(member).filter((row) => String(row.messageId).startsWith('startup-work:'));
  const markInboxRead = (member: string) => {
    const file = join(teamDir(), 'inboxes', `${member}.json`);
    if (!existsSync(file)) return;
    writeFileSync(file, JSON.stringify(inbox(member).map((row) => ({ ...row, read: true }))));
  };

  const run = (members: { name: string; providerId?: string }[]) => ({
    runId: 'run-1',
    teamName: 'fixture',
    allEffectiveMembers: members.map((member) => ({ ...member, role: 'developer' })),
  });

  const deliver = (
    memberName: string,
    launchAttemptId: string,
    members = [{ name: 'bob' }, { name: 'carol', providerId: 'opencode' }]
  ) =>
    deliverStartupWorkAfterConfirmation(run(members) as never, memberName, launchAttemptId, {
      createController: (input) => createController(input),
      getClaudeBasePath: () => claudeDir,
      appendMemberBootstrapDiagnostic: (_run, member, text) =>
        diagnostics.push(`${member}: ${text}`),
      logger: { warn: (message: string) => warnings.push(message) },
    });

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'startup-work-delivery-'));
    mkdirSync(teamDir(), { recursive: true });
    writeFileSync(
      join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
          { name: 'carol', role: 'developer', providerId: 'opencode' },
        ],
      })
    );
    diagnostics.length = 0;
    warnings.length = 0;
  });

  afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

  const board = () => createController({ teamName: 'fixture', claudeDir }).taskBoard;

  it('S1.3, S1.5: a native member gets its tasks as messages and a diagnostic records the count', () => {
    board().createTask({ subject: 'First job', owner: 'bob' });
    const second = board().createTask({ subject: 'Second job', owner: 'bob' });
    board().startTask(String((second as { id: string }).id), 'bob');
    markInboxRead('bob');

    deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(startupRows('bob')).toHaveLength(2);
    expect(startupRows('bob').every((row) => row.read === false)).toBe(true);
    expect(diagnostics).toEqual([expect.stringMatching(/^bob: .*2 .*task/i)]);
    expect(warnings).toEqual([]);
  });

  it('S1.17: an OpenCode member is left alone (its briefing keeps the task queue)', () => {
    board().createTask({ subject: 'OpenCode job', owner: 'carol' });
    markInboxRead('carol');

    deliver('carol', 'run-1@2026-10-22T10:00:00.000Z');

    expect(startupRows('carol')).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('a member with no work gets nothing and no diagnostic noise', () => {
    deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(inbox('bob')).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('S1.12: the same launch attempt delivers once', () => {
    board().createTask({ subject: 'Only once', owner: 'bob' });
    markInboxRead('bob');

    deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');
    markInboxRead('bob');
    deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');

    expect(startupRows('bob')).toHaveLength(1);
  });

  it('S1.18: a restart inside the same run is a new launch attempt and delivers again', () => {
    board().createTask({ subject: 'Survives a restart', owner: 'bob' });
    markInboxRead('bob');

    deliver('bob', 'run-1@2026-10-22T10:00:00.000Z');
    markInboxRead('bob');
    deliver('bob', 'run-1@2026-10-22T10:20:00.000Z');

    expect(startupRows('bob')).toHaveLength(2);
    expect(startupRows('bob')[1]?.read).toBe(false);
  });

  it('S1.19: a delivery failure is logged and recorded as a diagnostic, never swallowed', () => {
    // The member is in the run but not in the team config: the controller refuses it.
    deliver('stranger', 'run-1@2026-10-22T10:00:00.000Z', [{ name: 'stranger' }]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('stranger');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^stranger: .*(failed|could not)/i);
  });
});
