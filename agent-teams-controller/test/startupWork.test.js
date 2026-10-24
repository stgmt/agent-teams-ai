const fs = require('fs');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// Real controller on real files in a temp directory. No doubles: the only
// shortcut is rewriting inbox rows as read, which is exactly what a member
// process does after it has consumed a message in an earlier session.

describe('startup work delivery (bugfix: member startup)', () => {
  let dir;
  let board;
  let messages;
  let review;
  let tasks;

  const teamDir = () => path.join(dir, 'teams', 'fixture');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-work-'));
    fs.mkdirSync(teamDir(), { recursive: true });
    fs.writeFileSync(
      path.join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
          { name: 'carol', role: 'reviewer' },
        ],
      })
    );
    const controller = createController({ teamName: 'fixture', claudeDir: dir });
    board = controller.taskBoard;
    messages = controller.messages;
    review = controller.review;
    tasks = controller.tasks;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const inboxFile = (member) => path.join(teamDir(), 'inboxes', `${member}.json`);
  const inbox = (member) =>
    fs.existsSync(inboxFile(member)) ? JSON.parse(fs.readFileSync(inboxFile(member), 'utf8')) : [];
  const markInboxRead = (member) => {
    if (!fs.existsSync(inboxFile(member))) return;
    fs.writeFileSync(
      inboxFile(member),
      JSON.stringify(inbox(member).map((row) => ({ ...row, read: true })))
    );
  };
  const rowsForTask = (member, taskId) =>
    inbox(member).filter((row) => (row.taskRefs || []).some((ref) => ref.taskId === taskId));
  const startupRowsForTask = (member, taskId) =>
    rowsForTask(member, taskId).filter((row) => String(row.messageId).startsWith('startup-work:'));
  const createOwned = (subject, extra = {}) =>
    board.createTask({ subject, owner: 'bob', ...extra });

  describe('startup context carries no work (S1.14)', () => {
    const briefing = (options) =>
      board.memberBriefing('bob', { runtimeProvider: 'native', includeActiveProcesses: false, ...options });

    it('control: the ordinary member briefing lists the member tasks as Actionable', async () => {
      const task = createOwned('Prepare the quarterly numbers');
      board.startTask(task.id, 'bob');
      const text = String(await briefing({}));
      expect(text).toContain('Actionable:');
      expect(text).toContain('Prepare the quarterly numbers');
    });

    it('with deferTaskQueue the briefing has no Actionable block and no task subjects', async () => {
      const first = createOwned('Prepare the quarterly numbers');
      board.startTask(first.id, 'bob');
      createOwned('Reconcile the ledger');
      const text = String(await briefing({ deferTaskQueue: true }));
      expect(text).not.toContain('Actionable:');
      expect(text).not.toContain('Prepare the quarterly numbers');
      expect(text).not.toContain('Reconcile the ledger');
      expect(text).toContain('No Actionable work is loaded in this startup context');
      expect(text).toContain('New task assigned');
    });

    it('the deferred briefing keeps the role, protocol and roster sections', async () => {
      createOwned('Anything');
      const text = String(await briefing({ deferTaskQueue: true }));
      expect(text).toContain('Member briefing for bob on team "fixture"');
      expect(text).toContain('MANDATORY TASK STATUS PROTOCOL');
      expect(text).toContain('Team lead: alice.');
    });
  });

  describe('deliverStartupWork', () => {
    it('S1.5: one assignment per task the member owns (pending, in_progress, needsFix)', () => {
      const pending = createOwned('Pending work');
      const running = createOwned('Running work');
      board.startTask(running.id, 'bob');
      const fix = createOwned('Work needing a fix');
      board.startTask(fix.id, 'bob');
      board.completeTask(fix.id, 'bob');
      review.requestReview(fix.id, { from: 'alice', reviewer: 'carol' });
      review.startReview(fix.id, { from: 'carol' });
      review.requestChanges(fix.id, { from: 'carol', comment: 'Please redo the totals.' });
      markInboxRead('bob');

      const result = board.deliverStartupWork('bob', { launchId: 'launch-1' });

      expect(result.delivered.map((entry) => entry.taskId).sort()).toEqual(
        [pending.id, running.id, fix.id].sort()
      );
      for (const task of [pending, running, fix]) {
        const rows = rowsForTask('bob', task.id).filter((row) => row.read === false);
        expect(rows).toHaveLength(1);
        expect(rows[0].from).toBe('alice');
        expect(rows[0].source).toBe('system_notification');
        expect(rows[0].text).toContain('New task assigned to you:');
        expect(rows[0].summary).toBe(`New task #${task.displayId} assigned`);
      }
    });

    it('S1.7: a task already in_progress is handed over once, as work to resume', () => {
      const running = createOwned('Long running work');
      board.startTask(running.id, 'bob');
      markInboxRead('bob');

      board.deliverStartupWork('bob', { launchId: 'launch-1' });

      const unread = rowsForTask('bob', running.id).filter((row) => row.read === false);
      expect(unread).toHaveLength(1);
      expect(unread[0].text).toContain('status: in_progress');
      expect(unread[0].text).toContain('resume');
    });

    it('S1.4: the reviewer of a task in review gets a review request', () => {
      const done = createOwned('Finished work');
      board.startTask(done.id, 'bob');
      board.completeTask(done.id, 'bob');
      review.requestReview(done.id, { from: 'alice', reviewer: 'carol' });
      markInboxRead('carol');

      const result = board.deliverStartupWork('carol', { launchId: 'launch-1' });

      expect(result.delivered.map((entry) => entry.taskId)).toEqual([done.id]);
      const unread = rowsForTask('carol', done.id).filter((row) => row.read === false);
      expect(unread).toHaveLength(1);
      expect(unread[0].text).toContain('**Please review** task');
      expect(unread[0].summary).toBe(`Review request for #${done.displayId}`);
      expect(startupRowsForTask('bob', done.id)).toHaveLength(0);
    });

    it('S1.8: a needsFix task goes to its owner, not to the former reviewer', () => {
      const fix = createOwned('Needs a fix');
      board.startTask(fix.id, 'bob');
      board.completeTask(fix.id, 'bob');
      review.requestReview(fix.id, { from: 'alice', reviewer: 'carol' });
      review.startReview(fix.id, { from: 'carol' });
      review.requestChanges(fix.id, { from: 'carol', comment: 'Fix it.' });
      markInboxRead('bob');
      markInboxRead('carol');

      expect(board.deliverStartupWork('carol', { launchId: 'launch-1' }).delivered).toEqual([]);
      expect(board.deliverStartupWork('bob', { launchId: 'launch-1' }).delivered).toHaveLength(1);
    });

    it('S1.6: an unread assignment already in the inbox is not duplicated', () => {
      const task = createOwned('Already announced');
      expect(rowsForTask('bob', task.id).filter((row) => row.read === false)).toHaveLength(1);

      const result = board.deliverStartupWork('bob', { launchId: 'launch-1' });

      expect(result.delivered).toEqual([]);
      expect(result.skipped).toEqual([
        { taskId: task.id, kind: 'assignment', reason: 'unread_notification_exists' },
      ]);
      expect(rowsForTask('bob', task.id)).toHaveLength(1);
    });

    it('S1.9: a task blocked by an unfinished dependency is not delivered', () => {
      const blocker = createOwned('First step');
      const blocked = createOwned('Second step', { blockedBy: [blocker.id] });
      markInboxRead('bob');

      const result = board.deliverStartupWork('bob', { launchId: 'launch-1' });

      expect(result.delivered.map((entry) => entry.taskId)).toEqual([blocker.id]);
      expect(rowsForTask('bob', blocked.id).filter((row) => row.read === false)).toHaveLength(0);
    });

    it('S1.12: repeating the delivery for the same launch adds nothing, read or unread', () => {
      const task = createOwned('Once only');
      markInboxRead('bob');

      const first = board.deliverStartupWork('bob', { launchId: 'launch-1' });
      const whileUnread = board.deliverStartupWork('bob', { launchId: 'launch-1' });
      markInboxRead('bob');
      const afterRead = board.deliverStartupWork('bob', { launchId: 'launch-1' });

      expect(first.delivered).toHaveLength(1);
      expect(whileUnread.delivered).toEqual([]);
      expect(whileUnread.skipped).toEqual([
        { taskId: task.id, kind: 'assignment', reason: 'unread_notification_exists' },
      ]);
      expect(afterRead.delivered).toEqual([]);
      expect(afterRead.skipped).toEqual([
        { taskId: task.id, kind: 'assignment', reason: 'duplicate_message' },
      ]);
      expect(startupRowsForTask('bob', task.id)).toHaveLength(1);
    });

    it('S1.16: a new launch within 30 minutes is not swallowed by the repeated-message guard', () => {
      const task = createOwned('Survives a quick restart');
      board.startTask(task.id, 'bob');
      markInboxRead('bob');

      board.deliverStartupWork('bob', { launchId: 'launch-1' });
      markInboxRead('bob');
      const second = board.deliverStartupWork('bob', { launchId: 'launch-2' });

      expect(second.delivered.map((entry) => entry.taskId)).toEqual([task.id]);
      const rows = startupRowsForTask('bob', task.id);
      expect(rows).toHaveLength(2);
      expect(rows[1].read).toBe(false);
      expect(rows[1].text).not.toBe(rows[0].text);
      expect(rows[1].text).toContain('launch-2');
    });

    it('a member with nothing to do gets nothing', () => {
      expect(board.deliverStartupWork('bob', { launchId: 'launch-1' })).toEqual({
        memberName: 'bob',
        delivered: [],
        skipped: [],
      });
      expect(inbox('bob')).toEqual([]);
    });

    it('requires a launch id and a known member', () => {
      expect(() => board.deliverStartupWork('bob', {})).toThrow(/launchId/);
      expect(() => board.deliverStartupWork('bob')).toThrow(/launchId/);
      expect(() => board.deliverStartupWork('nobody', { launchId: 'launch-1' })).toThrow(
        /Member not found|Unknown/
      );
    });

    it('does not change the board (tasks and kanban stay as they were)', () => {
      const task = createOwned('Read only for the board');
      board.startTask(task.id, 'bob');
      markInboxRead('bob');
      const before = JSON.stringify(tasks.getTask(task.id));

      board.deliverStartupWork('bob', { launchId: 'launch-1' });

      expect(JSON.stringify(tasks.getTask(task.id))).toBe(before);
      expect(messages).toBeDefined();
    });
  });
});
