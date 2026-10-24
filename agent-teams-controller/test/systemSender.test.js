const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// Real controller on real files in a temp directory.
// The app tells the lead about stalled tasks with from: "system" (the stall monitor
// notifier). The controller used to reject that sender with "Unknown from: system",
// so every such notification failed and the lead never heard about a stalled task.

describe('system sender (bugfix: lead status)', () => {
  let dir;
  let appController;
  let agentController;

  const teamDir = () => path.join(dir, 'teams', 'fixture');
  const inbox = (member) => {
    const file = path.join(teamDir(), 'inboxes', `${member}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-sender-'));
    fs.mkdirSync(teamDir(), { recursive: true });
    fs.writeFileSync(
      path.join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
        ],
      })
    );
    appController = createController({ teamName: 'fixture', claudeDir: dir });
    agentController = createController({
      teamName: 'fixture',
      claudeDir: dir,
      allowUserMessageSender: false,
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const notice = {
    member: 'alice',
    from: 'system',
    summary: 'Potential stalled tasks detected',
    text: 'Task #1 has not been started.',
    source: 'system_notification',
  };

  it('the app context delivers a message from "system" to the lead inbox', () => {
    appController.messages.sendMessage(notice);

    const rows = inbox('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe('system');
    expect(rows[0].summary).toBe('Potential stalled tasks detected');
    expect(rows[0].read).toBe(false);
  });

  it('"system" is matched in any letter case and stored as "system"', () => {
    appController.messages.sendMessage({ ...notice, from: 'System' });

    expect(inbox('alice')[0].from).toBe('system');
  });

  it('an agent context cannot send as "system" (the sender is reserved for the app)', () => {
    expect(() => agentController.messages.sendMessage(notice)).toThrow(/reserved/);
    expect(inbox('alice')).toEqual([]);
  });

  it('control: an unknown sender is still rejected', () => {
    expect(() => appController.messages.sendMessage({ ...notice, from: 'ghost' })).toThrow(
      /Unknown from: ghost/
    );
    expect(inbox('alice')).toEqual([]);
  });

  it('control: a configured member still sends as themselves', () => {
    appController.messages.sendMessage({ ...notice, from: 'bob' });

    expect(inbox('alice')[0].from).toBe('bob');
  });
});
