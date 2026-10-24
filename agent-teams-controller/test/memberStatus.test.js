const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createController } = require('../src/index.js');

// Level L2 of the lead-status bugfix: the "Members" section of lead_briefing on real
// team files in a temp directory. Liveness comes from the app over the control API; where a
// test needs the app answering, a real HTTP server stands in (see the РИСК note below).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('lead_briefing: Members section (bugfix: lead status)', () => {
  let dir;
  let controller;
  let appServer = null;
  let savedControlUrl;

  const teamDir = () => path.join(dir, 'teams', 'fixture');
  const tasksDir = () => path.join(dir, 'tasks', 'fixture');
  const inboxFile = (member) => path.join(teamDir(), 'inboxes', `${member}.json`);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  const briefing = () => controller.taskBoard.leadBriefing();

  // The block of one member: its line and the indented task lines under it.
  const memberBlock = (text, name) => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`- ${name}:`));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  ')) end += 1;
    return lines.slice(start, end).join('\n');
  };

  // РИСК: давность записана тестом, а не набрана временем. Файл задачи переписывается с
  // прошлыми метками; сам формат записи тот же, что пишет настоящий контроллер.
  const rewriteTask = (taskId, mutate) => {
    const file = path.join(tasksDir(), `${taskId}.json`);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(task);
    fs.writeFileSync(file, JSON.stringify(task, null, 2));
  };

  // РИСК: сервер имитирует приложение. Он отвечает JSON такой же формы, как настоящий
  // маршрут `/members/diagnostics`; сами процессы членов и их проверку живости он не
  // покрывает (это уровень L3).
  const startFakeApp = async (members) => {
    appServer = http.createServer((request, response) => {
      if (request.url === '/api/teams/fixture/members/diagnostics') {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            teamName: 'fixture',
            generatedAt: new Date().toISOString(),
            runId: 'run-1',
            members,
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const { port } = appServer.address();
    fs.writeFileSync(
      path.join(dir, 'team-control-api.json'),
      JSON.stringify({ baseUrl: `http://127.0.0.1:${port}` })
    );
  };

  beforeEach(() => {
    savedControlUrl = process.env.CLAUDE_TEAM_CONTROL_URL;
    delete process.env.CLAUDE_TEAM_CONTROL_URL;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'member-status-'));
    fs.mkdirSync(teamDir(), { recursive: true });
    fs.writeFileSync(
      path.join(teamDir(), 'config.json'),
      JSON.stringify({
        name: 'fixture',
        leadSessionId: 'lead-session-1',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
          { name: 'carol', role: 'developer' },
          { name: 'rita', role: 'reviewer' },
        ],
      })
    );
    controller = createController({ teamName: 'fixture', claudeDir: dir });
  });

  afterEach(async () => {
    if (appServer) {
      await new Promise((resolve) => appServer.close(resolve));
      appServer = null;
    }
    if (savedControlUrl === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
    else process.env.CLAUDE_TEAM_CONTROL_URL = savedControlUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('S3.3: a task in progress shows the age since start and the age of the owner last action', async () => {
    const task = controller.taskBoard.createTask({ subject: 'Reconcile the ledger', owner: 'bob' });
    controller.taskBoard.startTask(task.id, 'bob');
    controller.tasks.addTaskComment(task.id, {
      from: 'bob',
      text: 'Halfway through the ledger.',
      createdAt: ago(35 * MINUTE),
    });
    rewriteTask(task.id, (row) => {
      row.workIntervals = [{ startedAt: ago(50 * MINUTE) }];
      row.historyEvents = row.historyEvents.map((event) =>
        event.type === 'status_changed' ? { ...event, timestamp: ago(50 * MINUTE) } : event
      );
    });

    const block = memberBlock(await briefing(), 'bob');

    expect(block).toContain(`#${task.displayId}`);
    expect(block).toContain('[status=in_progress');
    expect(block).toContain('started 50m ago');
    expect(block).toContain('last owner action 35m ago');
  });

  it('S3.2 (files part): an unread message that lay for days shows the count and its age', async () => {
    controller.messages.sendMessage({
      to: 'carol',
      from: 'alice',
      text: 'Please look at the kassa export.',
      summary: 'kassa export',
      timestamp: ago(65 * HOUR),
    });

    const block = memberBlock(await briefing(), 'carol');

    expect(block).toContain('unread=1');
    expect(block).toContain('oldest unread 65h');
    expect(block).toContain('from alice');
  });

  it('a message the member already consumed is not counted as unread', async () => {
    controller.messages.sendMessage({ to: 'carol', from: 'alice', text: 'Old news.' });
    controller.messages.sendMessage({ to: 'carol', from: 'alice', text: 'Fresh news.' });
    const rows = JSON.parse(fs.readFileSync(inboxFile('carol'), 'utf8'));
    rows[0].read = true;
    fs.writeFileSync(inboxFile('carol'), JSON.stringify(rows));

    expect(memberBlock(await briefing(), 'carol')).toContain('unread=1');
  });

  it('S3.4: a member without tasks and without messages is listed with zero unread and no tasks', async () => {
    const block = memberBlock(await briefing(), 'carol');

    expect(block).toContain('unread=0');
    expect(block).toContain('tasks=0');
  });

  it('S3.8: a task in review is shown at the reviewer with the review mark and at the owner', async () => {
    const task = controller.taskBoard.createTask({ subject: 'Ship the export', owner: 'bob' });
    controller.taskBoard.startTask(task.id, 'bob');
    controller.taskBoard.completeTask(task.id, 'bob');
    controller.taskBoard.requestReview(task.id, { from: 'bob', reviewer: 'rita' });

    const text = await briefing();
    const reviewerBlock = memberBlock(text, 'rita');
    const ownerBlock = memberBlock(text, 'bob');

    expect(reviewerBlock).toContain(`#${task.displayId}`);
    expect(reviewerBlock).toContain('review=review');
    expect(reviewerBlock).toContain('reviewer=rita');
    expect(ownerBlock).toContain(`#${task.displayId}`);
    expect(ownerBlock).toContain('reviewer=rita');
  });

  it('S3.12: a finished task is not listed as the member work', async () => {
    const task = controller.taskBoard.createTask({ subject: 'Old work', owner: 'bob' });
    controller.taskBoard.startTask(task.id, 'bob');
    controller.taskBoard.completeTask(task.id, 'bob');

    const block = memberBlock(await briefing(), 'bob');

    // The assignment notice in the inbox still names the task; only the task lines must be absent.
    expect(block).not.toMatch(/^ {2}- #/m);
    expect(block).toContain('tasks=0');
    expect(task.displayId).toBeTruthy();
  });

  it('S3.6: the app does not answer, so liveness is "no data" while files-based values stay', async () => {
    controller.messages.sendMessage({
      to: 'carol',
      from: 'alice',
      text: 'Waiting for you.',
      timestamp: ago(3 * HOUR),
    });
    // The state file points to a port nobody listens on.
    fs.writeFileSync(
      path.join(dir, 'team-control-api.json'),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:9' })
    );

    const text = await briefing();

    for (const name of ['alice', 'bob', 'carol', 'rita']) {
      expect(memberBlock(text, name)).toContain('running=no data');
    }
    expect(text).toMatch(/App liveness: no data \(/);
    expect(memberBlock(text, 'carol')).toContain('unread=1');
    expect(memberBlock(text, 'carol')).toContain('oldest unread 3h');
  });

  it('S3.6: no control address published at all gives "no data" with the reason', async () => {
    const text = await briefing();

    expect(memberBlock(text, 'bob')).toContain('running=no data');
    expect(text).toMatch(/App liveness: no data \(.*Team control API is unavailable/);
  });

  it('S3.7: an inbox of 2586 messages from the real writer does not break the briefing', async () => {
    for (let index = 0; index < 2586; index += 1) {
      controller.messages.sendMessage({
        to: 'alice',
        from: 'bob',
        text: `Progress note number ${index}`,
        summary: `note ${index}`,
        timestamp: ago((2586 - index) * 1000),
      });
    }
    const startedAt = Date.now();

    const text = await briefing();

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    for (const name of ['alice', 'bob', 'carol', 'rita']) {
      expect(memberBlock(text, name)).not.toBe('');
    }
    expect(memberBlock(text, 'alice')).toContain('unread=2586');
  }, 180_000);

  it('S3.1, S3.10: liveness from the app (running and confirmed, not confirmed, not running) and a member the app does not know', async () => {
    await startFakeApp([
      {
        memberName: 'bob',
        isLead: false,
        diagnostics: [],
        alive: true,
        runtimeAlive: true,
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        lastHeartbeatAt: ago(2 * MINUTE),
      },
      {
        memberName: 'carol',
        isLead: false,
        diagnostics: [],
        alive: true,
        runtimeAlive: true,
        launchState: 'runtime_pending_bootstrap',
        bootstrapConfirmed: false,
      },
      {
        memberName: 'rita',
        isLead: false,
        diagnostics: [],
        alive: false,
        launchState: 'failed_to_start',
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'model not found',
      },
    ]);

    const text = await briefing();

    expect(memberBlock(text, 'bob')).toContain('running=yes');
    expect(memberBlock(text, 'bob')).toContain('launch=confirmed_alive');
    expect(memberBlock(text, 'bob')).toContain('confirmed=yes');
    expect(memberBlock(text, 'bob')).toContain('heartbeat 2m ago');
    expect(memberBlock(text, 'carol')).toContain('running=yes');
    expect(memberBlock(text, 'carol')).toContain('confirmed=no');
    expect(memberBlock(text, 'rita')).toContain('running=no');
    expect(memberBlock(text, 'rita')).toContain('failure: model not found');
    expect(memberBlock(text, 'alice')).toContain('running=no data');
    expect(memberBlock(text, 'alice')).toContain('not in app diagnostics');
    expect(text).not.toMatch(/App liveness: no data/);
  });

  it('S3.2: a member whose process is gone is not running, whatever the launch state remembers', async () => {
    // Found in the live run: after the process of a confirmed member was ended the app kept
    // runtimeAlive=true and launchState=confirmed_alive, and said alive=false with the reason.
    await startFakeApp([
      {
        memberName: 'bob',
        isLead: false,
        diagnostics: ['persisted runtime pid is not alive'],
        alive: false,
        runtimeAlive: true,
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        runtimeDiagnostic: 'persisted runtime pid is not alive',
      },
      {
        memberName: 'carol',
        isLead: false,
        diagnostics: [],
        runtimeAlive: true,
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
      },
    ]);

    const text = await briefing();

    expect(memberBlock(text, 'bob')).toContain('running=no');
    expect(memberBlock(text, 'bob')).not.toContain('running=yes');
    expect(memberBlock(text, 'bob')).toContain('note: persisted runtime pid is not alive');
    // The process check is missing from the answer: the launch record is the only evidence.
    expect(memberBlock(text, 'carol')).toContain('running=yes');
  });

  it('the note and the failure of a member stay one field of its line: the app joins reasons with a semicolon', async () => {
    // Found in the third live run: the app writes `<reason>; process table unavailable` as one
    // runtimeDiagnostic, and the line of a member is split on "; ", so the tail of the note
    // looked like a field of its own.
    await startFakeApp([
      {
        memberName: 'bob',
        isLead: false,
        diagnostics: [],
        alive: false,
        runtimeAlive: true,
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        runtimeDiagnostic: 'persisted runtime pid is not alive; process table unavailable',
      },
      {
        memberName: 'carol',
        isLead: false,
        diagnostics: [],
        alive: false,
        runtimeAlive: false,
        launchState: 'failed_to_start',
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason: 'spawn failed; exit code 1',
      },
    ]);

    const text = await briefing();

    for (const name of ['bob', 'carol']) {
      const fields = memberBlock(text, name).split('\n')[0].split('; ');
      expect(fields, `${name} line fields`).toHaveLength(3);
      expect(fields[1]).toMatch(/^unread=/);
      expect(fields[2]).toMatch(/^tasks=/);
    }
    expect(memberBlock(text, 'bob')).toContain(
      'note: persisted runtime pid is not alive, process table unavailable'
    );
    expect(memberBlock(text, 'carol')).toContain('failure: spawn failed, exit code 1');
  });

  it('S3.2: a member that failed to start, with no process check in the answer, is not running', async () => {
    // Found in the second live run: the process of EPSILON was ended before it confirmed; the
    // app answered launchState=failed_to_start, runtimeAlive=true (the launch record) and no
    // alive field at all.
    await startFakeApp([
      {
        memberName: 'bob',
        isLead: false,
        diagnostics: [],
        runtimeAlive: true,
        launchState: 'failed_to_start',
        bootstrapConfirmed: false,
        memberCardError: 'process exited with code 1',
      },
      {
        // A live process that never confirmed is running, and says why it failed.
        memberName: 'carol',
        isLead: false,
        diagnostics: [],
        alive: true,
        runtimeAlive: true,
        launchState: 'failed_to_start',
        bootstrapConfirmed: false,
        memberCardError: 'did not bootstrap-confirm',
      },
    ]);

    const text = await briefing();

    expect(memberBlock(text, 'bob')).toContain('running=no');
    expect(memberBlock(text, 'bob')).toContain('failure: process exited with code 1');
    expect(memberBlock(text, 'carol')).toContain('running=yes');
    expect(memberBlock(text, 'carol')).toContain('failure: did not bootstrap-confirm');
  });

  it('S3.11: an unreadable inbox of one member is named for that member and the others stay intact', async () => {
    controller.messages.sendMessage({ to: 'rita', from: 'alice', text: 'Review soon.' });
    fs.mkdirSync(path.dirname(inboxFile('carol')), { recursive: true });
    fs.writeFileSync(inboxFile('carol'), '{ this is not json');

    const text = await briefing();

    expect(memberBlock(text, 'carol')).toContain('inbox unreadable');
    expect(memberBlock(text, 'rita')).toContain('unread=1');
  });
});
