const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// The guard against repeated messages (same sender, recipient, text and context within 30
// minutes) protects the team from an agent that says the same thing twice. A command of the app
// to a new launch attempt (the bootstrap check of a restarted teammate) is the same text on
// purpose every time: the second attempt must get its own row.
describe('repeated delivery of an app command', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeClaudeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-repeat-'));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, 'teams', 'my-team'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'teams', 'my-team', 'config.json'),
      JSON.stringify({
        name: 'my-team',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
        ],
      })
    );
    return dir;
  }

  function readInbox(claudeDir, member) {
    return JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'teams', 'my-team', 'inboxes', `${member}.json`), 'utf8')
    );
  }

  const CHECK_TEXT =
    '<agent_teams_native_app_managed_bootstrap_check>\n</agent_teams_native_app_managed_bootstrap_check>';

  function bootstrapCheck(index, extra = {}) {
    return {
      from: 'alice',
      to: 'bob',
      text: CHECK_TEXT,
      source: 'system_notification',
      leadSessionId: 'lead-session-1',
      summary: 'Bootstrap instructions for bob',
      messageId: `direct-member_updated-bob-${index}`,
      ...extra,
    };
  }

  it('still drops an identical second message in the same lead session (the guard stays)', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const first = controller.messages.sendMessage(bootstrapCheck(1));
    const second = controller.messages.sendMessage(bootstrapCheck(2));

    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBe(true);
    expect(second.deduplicationNotice).toContain('Duplicate message ignored');
    expect(readInbox(claudeDir, 'bob')).toHaveLength(1);
  });

  it('delivers every row the sender marks as an app command to a new attempt', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    const first = controller.messages.sendMessage(
      bootstrapCheck(1, { allowRepeatedDelivery: true })
    );
    // The first row is read by the first process before the second attempt starts.
    const inboxFile = path.join(claudeDir, 'teams', 'my-team', 'inboxes', 'bob.json');
    const rows = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    rows[0].read = true;
    fs.writeFileSync(inboxFile, JSON.stringify(rows));
    const second = controller.messages.sendMessage(
      bootstrapCheck(2, { allowRepeatedDelivery: true })
    );

    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    const stored = readInbox(claudeDir, 'bob');
    expect(stored.map((row) => row.messageId)).toEqual([
      'direct-member_updated-bob-1',
      'direct-member_updated-bob-2',
    ]);
    expect(stored[1].read).toBe(false);
  });

  it('does not store the delivery flag on the row', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    controller.messages.sendMessage(bootstrapCheck(1, { allowRepeatedDelivery: true }));

    expect(readInbox(claudeDir, 'bob')[0]).not.toHaveProperty('allowRepeatedDelivery');
  });

  it('ignores the flag from an agent tool context (only the app may skip the guard)', () => {
    const claudeDir = makeClaudeDir();
    const agentController = createController({
      teamName: 'my-team',
      claudeDir,
      allowUserMessageSender: false,
    });

    agentController.messages.sendMessage(bootstrapCheck(1, { allowRepeatedDelivery: true }));
    const second = agentController.messages.sendMessage(
      bootstrapCheck(2, { allowRepeatedDelivery: true })
    );

    expect(second.deduplicated).toBe(true);
    expect(readInbox(claudeDir, 'bob')).toHaveLength(1);
  });

  it('keeps the guard against the same message id even for an app command', () => {
    const claudeDir = makeClaudeDir();
    const controller = createController({ teamName: 'my-team', claudeDir });

    controller.messages.sendMessage(bootstrapCheck(1, { allowRepeatedDelivery: true }));
    const again = controller.messages.sendMessage(
      bootstrapCheck(1, { allowRepeatedDelivery: true })
    );

    expect(again.deduplicated).toBe(true);
    expect(readInbox(claudeDir, 'bob')).toHaveLength(1);
  });
});
